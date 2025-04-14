import { Request, Response } from 'express';
import pool from '../models/db';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

// Функция для определения MIME-типа по расширению
const getMimeType = (filename: string): string => {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: { [key: string]: string } = {
        // Изображения
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.tiff': 'image/tiff',
        '.svg': 'image/svg+xml',
        
        // Документы
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.txt': 'text/plain',
        '.csv': 'text/csv',
        '.rtf': 'application/rtf',
        
        // Архивы
        '.zip': 'application/zip',
        '.rar': 'application/x-rar-compressed',
        '.7z': 'application/x-7z-compressed',
        '.tar': 'application/x-tar',
        '.gz': 'application/gzip',
        
        // Аудио
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.midi': 'audio/midi',
        '.m4a': 'audio/x-m4a',
        '.aac': 'audio/aac',
        
        // Видео
        '.mp4': 'video/mp4',
        '.mpeg': 'video/mpeg',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.wmv': 'video/x-ms-wmv',
        '.webm': 'video/webm',
        
        // Другие
        '.json': 'application/json',
        '.xml': 'application/xml',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.html': 'text/html'
    };

    return mimeTypes[ext] || 'application/octet-stream';
};

// Настройка хранилища для multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(process.cwd(), 'uploads');
        // Создаем директорию, если она не существует
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        console.log('Директория для загрузки:', uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const filename = uniqueSuffix + path.extname(file.originalname);
        console.log('Сгенерированное имя файла:', filename);
        cb(null, filename);
    }
});

// Создаем экземпляр multer
export const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB
    },
    fileFilter: (req, file, cb) => {
        console.log('Получен файл с MIME-типом:', file.mimetype);
        console.log('Имя файла:', file.originalname);
        
        // Определяем MIME-тип по расширению
        const mimeType = getMimeType(file.originalname);
        console.log('Определенный MIME-тип:', mimeType);
        
        // Разрешаем только определенные типы файлов
        const allowedTypes = [
            // Изображения
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/webp',
            'image/bmp',
            'image/tiff',
            'image/svg+xml',
            
            // Документы
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'text/plain',
            'text/csv',
            'application/rtf',
            
            // Архивы
            'application/zip',
            'application/x-rar-compressed',
            'application/x-7z-compressed',
            'application/x-tar',
            'application/gzip',
            
            // Аудио
            'audio/mpeg',
            'audio/wav',
            'audio/ogg',
            'audio/midi',
            'audio/x-m4a',
            'audio/aac',
            
            // Видео
            'video/mp4',
            'video/mpeg',
            'video/quicktime',
            'video/x-msvideo',
            'video/x-ms-wmv',
            'video/webm',
            
            // Другие
            'application/json',
            'application/xml',
            'text/xml',
            'application/javascript',
            'text/css',
            'text/html'
        ];
        
        if (allowedTypes.includes(mimeType)) {
            // Переопределяем MIME-тип файла
            file.mimetype = mimeType;
            cb(null, true);
        } else {
            console.log('Неподдерживаемый тип файла:', mimeType);
            cb(new Error('Неподдерживаемый тип файла'));
        }
    }
});

export const uploadFile = async (req: Request, res: Response): Promise<void> => {
    try {
        console.log('Начало загрузки файла');
        console.log('Тело запроса:', req.body);
        console.log('Файл:', req.file);

        if (!req.file) {
            console.log('Файл не был загружен');
            res.status(400).json({ error: 'Файл не был загружен' });
            return;
        }

        const { conversation_id, sender_id, content, message_id } = req.body;
        console.log('Полученные параметры:', { conversation_id, sender_id, content, message_id });

        let messageId = message_id;

        // Если message_id не передан, создаем новое сообщение
        if (!messageId) {
            console.log('Создание нового сообщения...');
            const messageResult = await pool.query(
                `INSERT INTO messages (conversation_id, sender_id, content)
                 VALUES ($1, $2, $3)
                 RETURNING *`,
                [conversation_id, sender_id, content]
            );
            console.log('Сообщение создано:', messageResult.rows[0]);
            messageId = messageResult.rows[0].id;
        } else {
            console.log('Используем существующее сообщение:', messageId);
            // Проверяем существование сообщения
            const messageCheck = await pool.query(
                'SELECT * FROM messages WHERE id = $1',
                [messageId]
            );
            if (messageCheck.rows.length === 0) {
                console.log('Сообщение не найдено');
                res.status(404).json({ error: 'Сообщение не найдено' });
                return;
            }
        }

        // Проверяем, не был ли уже загружен этот файл
        const existingFile = await pool.query(
            'SELECT * FROM files WHERE message_id = $1 AND file_name = $2',
            [messageId, req.file.originalname]
        );

        if (existingFile.rows.length > 0) {
            console.log('Файл уже был загружен ранее:', existingFile.rows[0]);
            res.status(400).json({ error: 'Файл уже был загружен' });
            return;
        }

        // Сохраняем относительный путь к файлу
        const relativeFilePath = path.join('uploads', path.basename(req.file.path));

        // Сохраняем информацию о файле в базу данных
        console.log('Сохранение информации о файле...');
        const result = await pool.query(
            `INSERT INTO files (message_id, file_name, file_path, file_type, file_size)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [messageId, req.file.originalname, relativeFilePath, req.file.mimetype, req.file.size]
        );
        console.log('Файл сохранен:', result.rows[0]);

        // Получаем полную информацию о сообщении с файлом
        console.log('Получение полной информации о сообщении...');
        const fullMessageResult = await pool.query(
            `
            SELECT 
                m.*,
                COALESCE(
                    (SELECT json_agg(
                        json_build_object(
                            'id', f.id,
                            'file_name', f.file_name,
                            'file_path', f.file_path,
                            'file_type', f.file_type,
                            'file_size', f.file_size,
                            'created_at', f.created_at
                        )
                    )
                    FROM files f
                    WHERE f.message_id = m.id),
                    '[]'::json
                ) AS files
            FROM messages m
            WHERE m.id = $1
            `,
            [messageId]
        );
        console.log('Полная информация о сообщении:', fullMessageResult.rows[0]);

        res.status(201).json({
            message: fullMessageResult.rows[0],
            file: result.rows[0]
        });
        console.log('Ответ отправлен');
    } catch (err) {
        console.error('Ошибка при загрузке файла:', err);
        if (err instanceof Error && err.message === 'Неподдерживаемый тип файла') {
            res.status(400).json({ 
                error: 'Неподдерживаемый тип файла',
                details: `Тип файла: ${req.file?.mimetype}, Имя файла: ${req.file?.originalname}`
            });
        } else {
            res.status(500).json({ error: 'Ошибка при загрузке файла' });
        }
    }
};

export const downloadFile = async (req: Request, res: Response): Promise<void> => {
    try {
        const { fileId } = req.params;
        console.log('Запрос на скачивание файла:', fileId);

        // Получаем информацию о файле из базы данных
        const result = await pool.query(
            'SELECT * FROM files WHERE id = $1',
            [fileId]
        );

        if (result.rows.length === 0) {
            console.log('Файл не найден в базе данных');
            res.status(404).json({ error: 'Файл не найден' });
            return;
        }

        const file = result.rows[0];
        console.log('Информация о файле из БД:', file);

        // Используем относительный путь к файлу
        const filePath = path.join(process.cwd(), file.file_path);
        console.log('Полный путь к файлу:', filePath);

        // Проверяем существование файла
        if (!fs.existsSync(filePath)) {
            console.log('Файл не найден по указанному пути');
            res.status(404).json({ error: 'Файл не найден на сервере' });
            return;
        }

        // Отправляем файл
        console.log('Отправка файла...');
        res.download(filePath, file.file_name, (err) => {
            if (err) {
                console.error('Ошибка при отправке файла:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Ошибка при отправке файла' });
                }
            } else {
                console.log('Файл успешно отправлен');
            }
        });
    } catch (err) {
        console.error('Ошибка при скачивании файла:', err);
        res.status(500).json({ error: 'Ошибка при скачивании файла' });
    }
};

export const getFileInfo = async (req: Request, res: Response): Promise<void> => {
    try {
        const { fileId } = req.params;

        const result = await pool.query(
            'SELECT id, file_name, file_type, file_size, created_at FROM files WHERE id = $1',
            [fileId]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Файл не найден' });
            return;
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Ошибка при получении информации о файле:', err);
        res.status(500).json({ error: 'Ошибка при получении информации о файле' });
    }
}; 