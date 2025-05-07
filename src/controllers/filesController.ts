import { Request, Response } from 'express';
import pool from '../models/db';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import * as socketService from '../services/socketService'; // Импортируем сервис


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
        fileSize: 10 * 1024 * 1024 * 1024 // 10GB (10 * 1024^3 bytes)
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

        // Проверяем аутентификацию пользователя
        if (!req.user || !req.user.id) {
            console.log('Пользователь не аутентифицирован для загрузки файла');
            // Удаляем загруженный файл, так как пользователь не аутентифицирован
            fs.unlinkSync(req.file.path);
             console.log('Загруженный файл удален из-за отсутствия аутентификации');
            res.status(401).json({ error: 'Пользователь не аутентифицирован' });
            return;
        }
        const sender_id = req.user.id;

        // Получаем conversation_id из тела запроса
        const { conversation_id, content = '' } = req.body;

         if (!conversation_id) {
             console.log('Не указан conversation_id');
             fs.unlinkSync(req.file.path);
             console.log('Загруженный файл удален из-за отсутствия conversation_id');
             res.status(400).json({ error: 'Не указан ID разговора (conversation_id)' });
             return;
         }

        console.log('Полученные параметры:', { conversation_id, sender_id, content });

        // Начинаем транзакцию
        await pool.query('BEGIN');

        // Создаем новое сообщение
        console.log('Создание нового сообщения...');
        const messageResult = await pool.query(
            `INSERT INTO messages (conversation_id, sender_id, content)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [conversation_id, sender_id, content] // Используем content из body или пустую строку
        );
        const messageId = messageResult.rows[0].id;
        console.log('Сообщение создано с ID:', messageId);

        // Сохраняем относительный путь к файлу (относительно корня проекта)
        // const relativeFilePath = path.relative(process.cwd(), req.file.path);
        const absoluteFilePath = req.file.path; // Используем абсолютный путь, сохраненный multer

        // Сохраняем информацию о файле в базу данных
        console.log('Сохранение информации о файле...');
        const fileResult = await pool.query(
            `INSERT INTO files (message_id, file_name, file_path, file_type, file_size)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [messageId, req.file.originalname, absoluteFilePath, req.file.mimetype, req.file.size]
        );
        const fileId = fileResult.rows[0].id;
        console.log('Файл сохранен с ID:', fileId);

        // Отмечаем сообщение как прочитанное для отправителя
         await pool.query(
            `INSERT INTO message_reads (message_id, user_id, read_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (message_id, user_id) DO NOTHING`,
            [messageId, sender_id]
        );
        console.log(`Сообщение ${messageId} отмечено как прочитанное для отправителя ${sender_id}`);

        // Подтверждаем транзакцию
        await pool.query('COMMIT');

        // Получаем полную информацию о сообщении с файлом для отправки через WebSocket
        console.log('Получение полной информации о сообщении для WebSocket...');
        const fullMessageResult = await pool.query(
            `
            SELECT 
                m.id,
                m.conversation_id,
                m.sender_id,
                m.sender_username,
                m.content,
                m.created_at::text AS created_at,
                COALESCE(
                    (SELECT json_agg(
                        json_build_object(
                            'id', f.id,
                            'file_name', f.file_name,
                            'file_type', f.file_type,
                            'file_size', f.file_size,
                            'created_at', f.created_at::text,
                            'download_url', '/api/files/download/' || f.id::text
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

        if (fullMessageResult.rows.length === 0) {
            // Это не должно произойти, но на всякий случай
             console.error(`Не удалось получить данные сообщения ${messageId} после сохранения.`);
             // Не отправляем ошибку клиенту здесь, так как файл уже загружен,
             // но логируем для расследования.
        } else {
            const messageData = fullMessageResult.rows[0];
            let targetRoom: string | null = null;

            try {
                // --- Упрощенный блок для теста ---
                console.log('[Debug] Внутри try блока перед отправкой WebSocket.');
                
                targetRoom = messageData.conversation_id;
                if (!targetRoom) {
                    // Если ID комнаты нет, логируем и НЕ отправляем HTTP ответ здесь,
                    // ошибка обработается внешним catch или поведением по умолчанию.
                    console.error('!!! Conversation ID отсутствует в данных сообщения! Невозможно отправить WebSocket.');
                    throw new Error('Conversation ID отсутствует в данных сообщения!'); 
                }

                console.log(`[Debug] Готовимся отправить newMessage (оригинальные данные) в комнату: ${targetRoom}`);
                socketService.emitToRoom(targetRoom, 'newMessage', messageData); 
                console.log('[Debug] Вызов socketService.emitToRoom ЗАВЕРШЕН (вроде бы).');

                // --- Переносим HTTP ответ сюда ---
                console.log('[Debug] Готовимся отправить HTTP ответ клиенту (из try блока)...'); 
                 res.status(201).json({ 
                    message: 'Файл успешно загружен и сообщение создано',
                    fileId: fileId,
                    messageId: messageId,
                    fileInfo: messageData.files.find((f: any) => f.id === fileId)
                });
                console.log('[Debug] HTTP ответ отправлен (из try блока).');

            } catch (processingError: any) {
                console.error(`!!! ОБЩАЯ ОШИБКА при обработке данных или отправке WebSocket для messageId ${messageData?.id}:`, processingError);
                // Если ошибка произошла ДО отправки ответа, отправляем ошибку 500
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Внутренняя ошибка сервера при обработке файла или отправке WebSocket' });
                }
            }
        }

    } catch (error: any) {
         // Откатываем транзакцию в случае ошибки
        try {
            await pool.query('ROLLBACK');
            console.log('Транзакция отменена из-за ошибки');
        } catch (rollbackError) {
             console.error('Ошибка при отмене транзакции:', rollbackError);
        }
        
        console.error('Ошибка при загрузке файла:', error);

        // Удаляем загруженный файл, если произошла ошибка
        if (req.file && req.file.path) {
            try {
                if (fs.existsSync(req.file.path)) {
                    fs.unlinkSync(req.file.path);
                    console.log('Загруженный файл удален из-за ошибки сервера');
                }
            } catch (unlinkError) {
                console.error('Ошибка при удалении файла после ошибки сервера:', unlinkError);
            }
        }

        if (error instanceof multer.MulterError) {
            if (error.code === 'LIMIT_FILE_SIZE') {
                res.status(400).json({ error: 'Файл слишком большой (макс. 10GB)' });
            } else {
                 res.status(400).json({ error: `Ошибка Multer: ${error.message}` });
            }
        } else if (error.message === 'Неподдерживаемый тип файла') {
             res.status(400).json({ error: 'Неподдерживаемый тип файла' });
        } else {
            res.status(500).json({ error: 'Не удалось загрузить файл' });
        }
    }
};

// Функция для скачивания файла
export const downloadFile = async (req: Request, res: Response): Promise<void> => {
    const { file_id } = req.body;
    let userId = null;
    if (req.user) {
        userId = req.user.id;
    }

    console.log(`[downloadFile] Запрос на скачивание файла id: ${file_id} (из тела) пользователем ${userId}`);

    if (!userId) {
        res.status(401).json({ error: 'Пользователь не аутентифицирован' });
        return;
    }

    if (!file_id) {
        console.warn(`[downloadFile] file_id не найден в теле запроса.`);
        res.status(400).json({ error: 'Необходимо передать file_id в теле запроса' });
        return;
    }

    try {
        // 1. Получаем информацию о файле и связанном сообщении/разговоре
        const fileResult = await pool.query(
            `
            SELECT f.file_path, f.file_name, f.file_type, m.conversation_id
            FROM files f
            JOIN messages m ON f.message_id = m.id
            WHERE f.id = $1
            `,
            [file_id]
        );

        if (fileResult.rows.length === 0) {
            console.log(`Файл ${file_id} не найден в базе данных`);
            res.status(404).json({ error: 'Файл не найден' });
            return;
        }

        const { file_path, file_name, file_type, conversation_id } = fileResult.rows[0];

        // 2. Проверяем, является ли пользователь участником разговора, к которому прикреплен файл
        const participantCheck = await pool.query(
            `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
            [conversation_id, userId]
        );

        if (participantCheck.rows.length === 0) {
            console.log(`Пользователь ${userId} не является участником разговора ${conversation_id}`);
            res.status(403).json({ error: 'Доступ к файлу запрещен' });
            return;
        }

        // 3. Проверяем существование файла на диске
        // const absolutePath = path.join(process.cwd(), file_path); // Формируем абсолютный путь
         const absolutePath = path.resolve(file_path); // Используем абсолютный путь из БД
        console.log('Проверка пути к файлу:', absolutePath);
        
        if (!fs.existsSync(absolutePath)) {
            console.error(`Файл не найден на диске: ${absolutePath}`);
            res.status(404).json({ error: 'Файл не найден на сервере' });
            return;
        }

        // 4. Отправляем файл пользователю
        // Устанавливаем правильный Content-Type и имя файла для скачивания
        res.setHeader('Content-Type', file_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file_name)}"`);

        console.log(`Отправка файла ${file_name} пользователю ${userId}`);
        const fileStream = fs.createReadStream(absolutePath);
        fileStream.pipe(res);

        fileStream.on('error', (streamError) => {
            console.error('Ошибка при чтении файла для отправки:', streamError);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Не удалось отправить файл' });
            }
        });
        
        fileStream.on('close', () => {
            console.log(`Файл ${file_name} успешно отправлен.`);
        });

    } catch (error: any) {
        console.error(`Ошибка при скачивании файла ${file_id}:`, error);
        if (error.code === '22P02') {
            res.status(400).json({ error: 'Неверный формат ID файла' });
        } else {
            res.status(500).json({ error: 'Не удалось скачать файл' });
        }
    }
};

// Функция для получения информации о файле (если нужно)
export const getFileInfo = async (req: Request, res: Response): Promise<void> => {
    const { file_id } = req.body;
    console.log(`[getFileInfo] Запрос информации для file_id: ${file_id} (из тела)`);

    if (!file_id) {
        console.warn(`[getFileInfo] file_id не найден в теле запроса.`);
        res.status(400).json({ error: 'Необходимо передать file_id в теле запроса' });
        return;
    }

    try {
        const result = await pool.query(
            'SELECT id, file_name, file_type, file_size, created_at FROM files WHERE id = $1',
            [file_id]
        );

        if (result.rows.length === 0) {
            console.warn(`[getFileInfo] Файл с id ${file_id} НЕ НАЙДЕН в БД.`);
            res.status(404).json({ error: 'Файл не найден' });
            return;
        }

        console.log(`[getFileInfo] Информация для файла ${file_id} найдена.`);
        res.json(result.rows[0]);
    } catch (error: any) {
        console.error(`[getFileInfo] Ошибка при получении информации о файле ${file_id}:`, error);
        if (error.code === '22P02') {
            res.status(400).json({ error: 'Неверный формат ID файла' });
        } else {
            res.status(500).json({ error: 'Не удалось получить информацию о файле' });
        }
    }
}; 