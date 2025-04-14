import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { Request } from 'express';

// Определяем путь для сохранения загруженных файлов задач
// Можно сделать его подпапкой в основной 'uploads'
const taskUploadsDir = path.join(__dirname, '..', '..', 'uploads', 'tasks');

// Создаем папку, если она не существует
if (!fs.existsSync(taskUploadsDir)) {
    fs.mkdirSync(taskUploadsDir, { recursive: true });
    console.log(`Папка для загрузки файлов задач создана: ${taskUploadsDir}`);
}

// Настройка хранилища Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Указываем папку для сохранения
        cb(null, taskUploadsDir);
    },
    filename: (req, file, cb) => {
        // Генерируем уникальное имя файла, сохраняя оригинальное расширение
        // Пример: task-1700000000000-originalname.pdf
        const uniqueSuffix = `task-${Date.now()}-${Math.round(Math.random() * 1E9)}`;
        const extension = path.extname(file.originalname);
        cb(null, `${uniqueSuffix}${extension}`);
    }
});

// Фильтр файлов (опционально) - можно настроить допустимые типы MIME
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    // Пример: разрешить только изображения и PDF
    // if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png' || file.mimetype === 'application/pdf') {
    //     cb(null, true);
    // } else {
    //     cb(new Error('Недопустимый тип файла!'));
    // }
    // В данном случае разрешаем все типы файлов
    cb(null, true);
};

// Создаем middleware multer с настроенным хранилищем и фильтром
// 'file' - это имя поля в форме multipart/form-data, через которое будет отправляться файл
const uploadTaskAttachment = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 1024 * 1024 * 50 // Ограничение размера файла (например, 50 МБ)
    }
}).single('file'); // .single() для загрузки одного файла

export default uploadTaskAttachment; 