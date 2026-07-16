import multer from "multer";
import { v2 as cloudinary } from "cloudinary";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 5);

const storage = multer.memoryStorage();

export const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
    files: 1,
  },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME.has(file.mimetype))
      return cb(new Error("Only JPG, PNG, WEBP or GIF images are allowed"));

    cb(null, true);
  },
});

export async function uploadToCloudinary(buffer, folder = "serveqr") {

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );

    stream.end(buffer);
  });
}