import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HttpError } from './lib.js';

export const uploadDirectory = fileURLToPath(new URL('../storage/uploads/', import.meta.url));
export function validMagic(buffer) {
  return (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
    (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP');
}
export async function validateImages(
  images,
  user,
  { required = false } = {}
) {
  if (
    !Array.isArray(images) ||
    images.length > 5 ||
    (required && images.length < 1)
  ) {
    throw new HttpError(
      400,
      required
        ? "Vui lòng tải lên từ 1 đến 5 ảnh minh chứng."
        : "Danh sách hình ảnh không hợp lệ."
    );
  }

  const result = [];

  for (const url of images) {
    if (typeof url !== "string") {
      throw new HttpError(
        400,
        "Chỉ sử dụng ảnh bạn đã tải lên qua hệ thống."
      );
    }

    // URL phải đúng dạng /uploads/tên-file
    const fileName = path.basename(url);

    if (url !== `/uploads/${fileName}`) {
      throw new HttpError(
        400,
        "Đường dẫn ảnh không hợp lệ."
      );
    }

    // File phải thuộc đúng người đang đăng nhập
    const ownerPrefix = `${String(user.id)}--`;

    if (!fileName.startsWith(ownerPrefix)) {
      throw new HttpError(
        400,
        "Chỉ sử dụng ảnh bạn đã tải lên qua hệ thống."
      );
    }

    // Phần sau MaNguoiDung phải là UUID do server tạo
    const generatedPart = fileName.slice(ownerPrefix.length);

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i.test(
        generatedPart
      )
    ) {
      throw new HttpError(
        400,
        "Tên file ảnh không hợp lệ."
      );
    }

    try {
      await fs.access(
        path.join(uploadDirectory, fileName)
      );
    } catch {
      throw new HttpError(
        400,
        "Không tìm thấy ảnh đã tải lên. Vui lòng tải lại."
      );
    }

    if (!result.includes(url)) {
      result.push(url);
    }
  }

  return result;
}
