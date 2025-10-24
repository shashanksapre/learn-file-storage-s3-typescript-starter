import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";
import { randomBytes } from "crypto";

const MAX_UPLOAD_SIZE = 10 << 20;

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };

  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  console.log("uploading thumbnail for video", videoId, "by user", userID);
  const formData = await req.formData();
  const thumbnail = formData.get("thumbnail");

  if (!(thumbnail instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail file size is greater than 10MB");
  }

  const mediaType = thumbnail.type;

  if (!["image/jpeg", "image/png"].includes(mediaType)) {
    throw new BadRequestError("Only JPEG and PNG files allowed!");
  }
  const data = await thumbnail.arrayBuffer();
  const video = getVideo(cfg.db, videoId);

  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  if (video.userID !== userID) {
    throw new UserForbiddenError("Editing video not allowed.");
  }

  // in memory
  // videoThumbnails.set(video.id, { mediaType, data });
  // const thumbnailUrl = `http://localhost:${cfg.port}/api/thumbnails/${video.id}`;
  // video.thumbnailURL = thumbnailUrl;

  // base64 encoding in db
  // const base64Data = Buffer.from(data).toString("base64");
  // video.thumbnailURL = `data:${mediaType};base64,${base64Data}`;

  // filesystem
  // const extension = mediaType.split("/")[1];
  // Bun.write(path.join(cfg.assetsRoot, `${videoId}.${extension}`), data);
  // video.thumbnailURL = `http://localhost:${cfg.port}/assets/${video.id}.${extension}`;

  // filesystem with random name
  const name = randomBytes(32).toString("base64url");
  const extension = mediaType.split("/")[1];
  Bun.write(path.join(cfg.assetsRoot, `${name}.${extension}`), data);
  video.thumbnailURL = `http://localhost:${cfg.port}/assets/${name}.${extension}`;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
