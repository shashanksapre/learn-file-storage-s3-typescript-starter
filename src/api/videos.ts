import {
  readableStreamToArrayBuffer,
  readableStreamToText,
  type BunRequest,
} from "bun";
import path from "path";
import { randomBytes } from "crypto";

import { respondWithJSON } from "./json.js";
import { type ApiConfig } from "../config.js";
import {
  BadRequestError,
  NotFoundError,
  UserForbiddenError,
} from "./errors.js";
import { getBearerToken, validateJWT } from "../auth.js";
import { getVideo, updateVideo, type Video } from "../db/videos.js";

const MAX_UPLOAD_SIZE = 1 << 30;

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };

  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  const video = getVideo(cfg.db, videoId);

  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  if (video.userID !== userID) {
    throw new UserForbiddenError("Editing video not allowed.");
  }

  const formData = await req.formData();
  const upload = formData.get("video");

  if (!(upload instanceof File)) {
    throw new BadRequestError("video file missing");
  }

  if (upload.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("video file size is greater than 1GB");
  }

  const mediaType = upload.type;

  if (!["video/mp4"].includes(mediaType)) {
    throw new BadRequestError("Only JPEG and PNG files allowed!");
  }

  const extension = mediaType.split("/")[1];
  const data = await upload.arrayBuffer();
  const filePath = path.join(cfg.assetsRoot, `${videoId}.${extension}`);
  await Bun.write(filePath, data);
  const category = await getVideoAspectRatio(filePath);
  const name = randomBytes(32).toString("hex");
  const key = `${category}/${name}.${extension}`;

  const s3File = cfg.s3Client.file(key, {
    type: mediaType,
  });

  const processesFilePath = await processVideoForFastStart(filePath);
  const file = Bun.file(processesFilePath);
  await s3File.write(file);
  // video.videoURL = `https://tubely-64554.s3.us-east-1.amazonaws.com/${key}`;
  video.videoURL = `${cfg.s3CfDistribution}/${key}`;

  updateVideo(cfg.db, video);
  await file.delete();
  // const signedVideo = dbVideoToSignedVideo(cfg, video);
  return respondWithJSON(200, video);
}

async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const exited = await proc.exited;

  if (exited) {
    const errBuffer = await readableStreamToArrayBuffer(proc.stderr!);
    const err = new TextDecoder().decode(errBuffer);
    throw new Error(err);
  }

  const outBuffer = await readableStreamToArrayBuffer(proc.stdout);
  const out = new TextDecoder().decode(outBuffer);
  const output = JSON.parse(out);

  if (!output.streams || output.streams.length === 0) {
    throw new Error("No video streams found");
  }

  const { width, height } = output.streams[0];

  return width === Math.floor(16 * (height / 9))
    ? "landscape"
    : height === Math.floor(16 * (width / 9))
    ? "portrait"
    : "other";
}

async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = `${inputFilePath}.processed`;

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const exited = await proc.exited;

  if (exited) {
    const errBuffer = await readableStreamToArrayBuffer(proc.stderr!);
    const err = new TextDecoder().decode(errBuffer);
    throw new Error(err);
  }

  return outputFilePath;
}

// function generatePresignedURL(
//   cfg: ApiConfig,
//   key: string,
//   expireTime: number
// ): string {
//   return cfg.s3Client.presign(key, {
//     expiresIn: expireTime,
//   });
// }

// export function dbVideoToSignedVideo(cfg: ApiConfig, video: Video): Video {
//   const preSignedUrl = generatePresignedURL(cfg, video.videoURL!, 300);
//   return { ...video, videoURL: preSignedUrl };
// }
