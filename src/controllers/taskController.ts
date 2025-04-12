import { Request, Response } from 'express';
import pool from '../models/db';
import { PoolClient } from 'pg'; // Импортируем PoolClient для транзакций
import path from 'path'; // Добавляем импорт path
import fs from 'fs'; // Добавляем импорт fs

// Функция для создания новой задачи
export const createTask = async (req: Request, res: Response): Promise<void> => {
    // Получаем данные из тела запроса
    const { title, description, status, priority, assignee_id, due_date } = req.body;
    // Получаем ID создателя из данных аутентифицированного пользователя
    const creator_id = req.user?.id;

    // Проверяем, есть ли обязательное поле title и ID создателя
    if (!title || !creator_id) {
        res.status(400).json({ error: 'Необходимо указать название задачи и ID создателя.' });
        return;
    }

    try {
        // Выполняем SQL-запрос для вставки новой задачи в таблицу tasks
        const result = await pool.query(
            `INSERT INTO tasks (title, description, status, priority, creator_id, assignee_id, due_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`, // Возвращаем созданную задачу
            [title, description, status || 'open', priority || 3, creator_id, assignee_id, due_date]
        );

        // Отправляем созданную задачу в ответе со статусом 201 (Created)
        res.status(201).json(result.rows[0]);
        console.log(`Задача "${title}" (ID: ${result.rows[0].id}) создана пользователем ${creator_id}`);

    } catch (error: any) { // Указываем тип any
        // В случае ошибки отправляем статус 500 и сообщение об ошибке
        console.error('Ошибка при создании задачи:', error);
        res.status(500).json({ error: 'Не удалось создать задачу' });
    }
};


// Функция для получения списка задач
export const getTasks = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id; // ID текущего пользователя
    const { status, search } = req.query; // Получаем параметры фильтрации и поиска из запроса

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    try {
        let queryText = `
            SELECT t.*, 
                   creator.username AS creator_username, 
                   assignee.username AS assignee_username
            FROM tasks t
            LEFT JOIN users creator ON t.creator_id = creator.id
            LEFT JOIN users assignee ON t.assignee_id = assignee.id
            WHERE (t.creator_id = $1 OR t.assignee_id = $1)
        `;
        const queryParams: any[] = [userId];
        let paramIndex = 2; // Начинаем со второго параметра ($2)

        // Добавляем фильтр по статусу, если он указан
        if (status) {
            queryText += ` AND t.status = $${paramIndex++}`;
            queryParams.push(status);
        }

        // Добавляем поиск по названию или описанию, если он указан
        if (search) {
            queryText += ` AND (t.title ILIKE $${paramIndex} OR t.description ILIKE $${paramIndex})`;
            queryParams.push(`%${search}%`); // ILIKE для регистронезависимого поиска
        }

        queryText += ` ORDER BY t.created_at DESC`; // Сортируем по дате создания

        const result = await pool.query(queryText, queryParams);

        res.status(200).json(result.rows);
        console.log(`Получен список задач для пользователя ${userId} с фильтрами: status=${status}, search=${search}`);

    } catch (error: any) { // Указываем тип any
        console.error('Ошибка при получении списка задач:', error);
        res.status(500).json({ error: 'Не удалось получить список задач' });
    }
};

// Функция для получения задачи по ID
export const getTaskById = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id; // ID текущего пользователя
    const { id } = req.params; // Получаем ID задачи из параметров URL

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!id) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }

    try {
        const queryText = `
            SELECT t.*, 
                   creator.username AS creator_username, 
                   assignee.username AS assignee_username
            FROM tasks t
            LEFT JOIN users creator ON t.creator_id = creator.id
            LEFT JOIN users assignee ON t.assignee_id = assignee.id
            WHERE t.id = $1
        `;
        
        const result = await pool.query(queryText, [id]);

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка доступа к несуществующей задаче ID: ${id} пользователем ${userId}`);
            return;
        }

        const task = result.rows[0];

        // Проверяем, имеет ли пользователь доступ к задаче
        if (task.creator_id !== userId && task.assignee_id !== userId) {
             // Можно расширить логику доступа, например, для администраторов или участников проекта
            res.status(403).json({ error: 'Доступ к этой задаче запрещен.' });
            console.log(`Пользователь ${userId} пытался получить доступ к задаче ${id}, к которой не имеет отношения.`);
            return;
        }

        res.status(200).json(task);
        console.log(`Получена задача ID: ${id} пользователем ${userId}`);

    } catch (error: any) { // Указываем тип any
        console.error(`Ошибка при получении задачи ID ${id}:`, error);
        // Проверка на неверный формат UUID
        if (error.code === '22P02') { 
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось получить задачу' });
        }
    }
};


// Функция для обновления задачи
export const updateTask = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id; // ID текущего пользователя
    const { id } = req.params; // ID задачи
    const updates = req.body; // Обновляемые поля { title, description, status, priority, assignee_id, due_date }

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!id) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }

    // Проверяем, есть ли что обновлять
    if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'Нет данных для обновления.' });
        return;
    }

    // Список допустимых для обновления полей
    const allowedUpdates = ['title', 'description', 'status', 'priority', 'assignee_id', 'due_date'];
    const updatesToApply: { [key: string]: any } = {};
    const logEntries: any[] = []; // Массив для записей в лог

    // Фильтруем только разрешенные поля
    Object.keys(updates).forEach(key => {
        if (allowedUpdates.includes(key)) {
            updatesToApply[key] = updates[key];
        }
    });

    if (Object.keys(updatesToApply).length === 0) {
        res.status(400).json({ error: 'Переданы недопустимые поля для обновления.' });
        return;
    }

    let client: PoolClient | null = null; // Объявляем клиент вне блока try

    try {
        client = await pool.connect(); // Получаем клиента из пула для транзакции
        await client.query('BEGIN'); // Начинаем транзакцию

        // 1. Получаем текущее состояние задачи и проверяем права доступа
        const currentTaskResult = await client.query('SELECT * FROM tasks WHERE id = $1', [id]);

        if (currentTaskResult.rows.length === 0) {
            await client.query('ROLLBACK'); // Откатываем транзакцию
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка обновить несуществующую задачу ID: ${id} пользователем ${userId}`);
            return;
        }

        const currentTask = currentTaskResult.rows[0];

        // Проверка прав: обновлять может создатель или исполнитель
        if (currentTask.creator_id !== userId && currentTask.assignee_id !== userId) {
            await client.query('ROLLBACK');
            res.status(403).json({ error: 'У вас нет прав на обновление этой задачи.' });
            console.log(`Пользователь ${userId} пытался обновить задачу ${id}, к которой не имеет отношения.`);
            return;
        }

        // 2. Формируем SQL-запрос для обновления и собираем данные для логов
        const setClauses: string[] = [];
        const queryParams: any[] = [];
        let paramIndex = 1;

        Object.keys(updatesToApply).forEach(key => {
            const oldValue = currentTask[key];
            const newValue = updatesToApply[key];

            // Обновляем поле только если значение действительно изменилось
            // Сравниваем значения, учитывая null/undefined
            if (String(oldValue ?? '') !== String(newValue ?? '')) {
                setClauses.push(`${key} = $${paramIndex++}`);
                queryParams.push(newValue);

                // Готовим запись для лога
                 logEntries.push({
                    task_id: id,
                    action: `update_${key}`, // Например, update_status, update_assignee_id
                    old_value: String(oldValue ?? 'null'), // Преобразуем в строку для единообразия
                    new_value: String(newValue ?? 'null'),
                    changed_by: userId
                });
            }
        });

        // Если нет полей для обновления (значения не изменились), просто выходим
        if (setClauses.length === 0) {
             await client.query('ROLLBACK'); // Ничего не изменилось, откатываем (или можно COMMIT)
             res.status(200).json(currentTask); // Возвращаем текущую задачу без изменений
             console.log(`Попытка обновить задачу ID: ${id} пользователем ${userId}, но значения не изменились.`);
             return;
        }


        // Добавляем updated_at, который обновится триггером, но нужен для RETURNING
        queryParams.push(id); // Добавляем ID задачи для WHERE

        const updateQuery = `
            UPDATE tasks
            SET ${setClauses.join(', ')}
            WHERE id = $${paramIndex}
            RETURNING *`;

        // 3. Выполняем обновление
        const updatedTaskResult = await client.query(updateQuery, queryParams);
        const updatedTask = updatedTaskResult.rows[0];

        // 4. Записываем логи изменений
        if (logEntries.length > 0) {
            const logValues = logEntries.map(entry => 
                `('${entry.task_id}', '${entry.action}', '${entry.old_value}', '${entry.new_value}', '${entry.changed_by}')`
            ).join(',');

            const logQuery = `
                INSERT INTO task_logs (task_id, action, old_value, new_value, changed_by)
                VALUES ${logValues}`;
                
            await client.query(logQuery);
        }

        await client.query('COMMIT'); // Подтверждаем транзакцию
        res.status(200).json(updatedTask);
        console.log(`Задача ID: ${id} успешно обновлена пользователем ${userId}. Изменения:`, logEntries.map(l=>l.action));

    } catch (error: any) { // Указываем тип any
        if (client) {
            await client.query('ROLLBACK'); // Откатываем транзакцию в случае любой ошибки
        }
        console.error(`Ошибка при обновлении задачи ID ${id}:`, error);
         // Проверка на неверный формат UUID
        if (error.code === '22P02' && error.message.includes('invalid input syntax for type uuid')) { 
             res.status(400).json({ error: 'Неверный формат ID задачи или ID пользователя.' });
        } else if (error.code === '23503') { // Ошибка внешнего ключа (например, неверный assignee_id)
             res.status(400).json({ error: 'Неверный ID исполнителя.' });
        } else {
             res.status(500).json({ error: 'Не удалось обновить задачу' });
        }
    } finally {
        if (client) {
            client.release(); // Возвращаем клиента обратно в пул
        }
    }
};


// Функция для удаления задачи
export const deleteTask = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id; // ID текущего пользователя
    const { id } = req.params; // ID задачи

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!id) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }

    let client: PoolClient | null = null;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // 1. Проверяем существование задачи и права на удаление (только создатель)
        const taskResult = await client.query('SELECT creator_id FROM tasks WHERE id = $1', [id]);

        if (taskResult.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка удалить несуществующую задачу ID: ${id} пользователем ${userId}`);
            return;
        }

        const task = taskResult.rows[0];

        if (task.creator_id !== userId) {
            await client.query('ROLLBACK');
            res.status(403).json({ error: 'У вас нет прав на удаление этой задачи (только создатель).' });
            console.log(`Пользователь ${userId} пытался удалить задачу ${id}, не являясь её создателем.`);
            return;
        }

        // 2. Удаляем задачу (связанные данные удалятся через ON DELETE CASCADE)
        await client.query('DELETE FROM tasks WHERE id = $1', [id]);

        // 3. Опционально: можно добавить запись в task_logs о том, что задача удалена,
        // но т.к. сама задача удаляется, эта запись будет ссылаться на несуществующий task_id.
        // Возможно, лучше не логировать само удаление или использовать отдельную таблицу аудита.

        await client.query('COMMIT');
        res.status(204).send(); // 204 No Content - успешное удаление без тела ответа
        console.log(`Задача ID: ${id} успешно удалена пользователем ${userId}.`);

    } catch (error: any) { // Указываем тип any
        if (client) {
            await client.query('ROLLBACK');
        }
        console.error(`Ошибка при удалении задачи ID ${id}:`, error);
        if (error.code === '22P02') {
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось удалить задачу' });
        }
    } finally {
        if (client) {
            client.release();
        }
    }
};


// Функция для добавления комментария к задаче
export const addTaskComment = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id; // ID текущего пользователя (комментатора)
    const { id: taskId } = req.params; // ID задачи из URL
    const { comment } = req.body; // Текст комментария из тела запроса

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }

    if (!comment || typeof comment !== 'string' || comment.trim() === '') {
        res.status(400).json({ error: 'Текст комментария не может быть пустым.' });
        return;
    }

    let client: PoolClient | null = null;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // 1. Проверяем существование задачи и права доступа к ней (читать/комментировать)
        const taskResult = await client.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);

        if (taskResult.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка комментировать несуществующую задачу ID: ${taskId} пользователем ${userId}`);
            return;
        }

        const task = taskResult.rows[0];

        // Разрешаем комментировать создателю и исполнителю
        if (task.creator_id !== userId && task.assignee_id !== userId) {
            await client.query('ROLLBACK');
            res.status(403).json({ error: 'У вас нет прав комментировать эту задачу.' });
            console.log(`Пользователь ${userId} пытался комментировать задачу ${taskId}, к которой не имеет отношения.`);
            return;
        }

        // 2. Добавляем комментарий
        const commentResult = await client.query(
            `INSERT INTO task_comments (task_id, commenter_id, comment)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [taskId, userId, comment.trim()]
        );

        const newComment = commentResult.rows[0];

        // 3. Получаем имя комментатора для ответа
        const commenterResult = await client.query('SELECT username FROM users WHERE id = $1', [userId]);
        const commenterUsername = commenterResult.rows[0]?.username || 'Неизвестный пользователь';

        await client.query('COMMIT');

        // Возвращаем комментарий с именем пользователя
        res.status(201).json({ ...newComment, commenter_username: commenterUsername });
        console.log(`Пользователь ${userId} добавил комментарий к задаче ${taskId}.`);

    } catch (error: any) { // Указываем тип any
        if (client) {
            await client.query('ROLLBACK');
        }
        console.error(`Ошибка при добавлении комментария к задаче ${taskId}:`, error);
        if (error.code === '22P02') {
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось добавить комментарий' });
        }
    } finally {
        if (client) {
            client.release();
        }
    }
};

// Функция для получения комментариев задачи
export const getTaskComments = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id; // ID текущего пользователя
    const { id: taskId } = req.params; // ID задачи из URL

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }

    try {
        // 1. Проверяем существование задачи и права доступа к ней (для просмотра комментариев)
        const taskResult = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);

        if (taskResult.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            return;
        }

        const task = taskResult.rows[0];
        if (task.creator_id !== userId && task.assignee_id !== userId) {
            res.status(403).json({ error: 'У вас нет прав на просмотр комментариев этой задачи.' });
            return;
        }

        // 2. Получаем комментарии с именами пользователей
        const commentsResult = await pool.query(
            `SELECT tc.*, u.username AS commenter_username
             FROM task_comments tc
             JOIN users u ON tc.commenter_id = u.id
             WHERE tc.task_id = $1
             ORDER BY tc.created_at ASC`, // Сортируем по времени создания
            [taskId]
        );

        res.status(200).json(commentsResult.rows);
        console.log(`Получены комментарии для задачи ${taskId} пользователем ${userId}.`);

    } catch (error: any) { // Указываем тип any
        console.error(`Ошибка при получении комментариев для задачи ${taskId}:`, error);
        if (error.code === '22P02') {
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось получить комментарии' });
        }
    }
};


// Функция для добавления вложения (файла) к задаче
export const addTaskAttachment = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { id: taskId } = req.params;

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }
    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }
    if (!req.file) {
        res.status(400).json({ error: 'Файл не был загружен.' });
        return;
    }

    const { originalname, filename, path: filePath, mimetype, size } = req.file;

    let client: PoolClient | null = null;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // 1. Проверяем существование задачи и права доступа (создатель или исполнитель)
        const taskResult = await client.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskResult.rows.length === 0) {
            await client.query('ROLLBACK');
            // Важно удалить загруженный файл, если задача не найдена
            try {
                fs.unlinkSync(filePath);
                console.log(`Удален файл ${filename} т.к. задача ${taskId} не найдена.`);
            } catch (unlinkErr) {
                console.error(`Ошибка при удалении файла ${filename}:`, unlinkErr);
            }
            res.status(404).json({ error: 'Задача не найдена.' });
            return;
        }
        const task = taskResult.rows[0];
        if (task.creator_id !== userId && task.assignee_id !== userId) {
            await client.query('ROLLBACK');
            try {
                fs.unlinkSync(filePath);
                 console.log(`Удален файл ${filename} т.к. у пользователя ${userId} нет прав на задачу ${taskId}.`);
            } catch (unlinkErr) {
                console.error(`Ошибка при удалении файла ${filename}:`, unlinkErr);
            }
            res.status(403).json({ error: 'У вас нет прав добавлять вложения к этой задаче.' });
            return;
        }

        // 2. Сохраняем информацию о файле в базу данных
        // Сохраняем относительный путь от папки uploads
        const relativePath = path.relative(path.join(__dirname, '..', '..', 'uploads'), filePath);

        const attachmentResult = await client.query(
            `INSERT INTO task_attachments (task_id, file_name, file_path, file_type, file_size)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [taskId, originalname, relativePath, mimetype, size]
        );

        await client.query('COMMIT');
        res.status(201).json(attachmentResult.rows[0]);
        console.log(`Пользователь ${userId} добавил файл ${originalname} к задаче ${taskId}. Путь: ${relativePath}`);

    } catch (error: any) { // Указываем тип any
        if (client) {
            await client.query('ROLLBACK');
        }
        // Если произошла ошибка после загрузки файла, его нужно удалить
        if (req.file) { // Проверяем, что файл вообще был
             try {
                 fs.unlinkSync(req.file.path);
                 console.log(`Удален файл ${req.file.filename} из-за ошибки сохранения вложения.`);
             } catch (unlinkErr: any) { // Указываем тип any
                 console.error(`Ошибка при удалении файла ${req.file.filename}:`, unlinkErr);
             }
        }
        console.error(`Ошибка при добавлении вложения к задаче ${taskId}:`, error);
         if (error.code === '22P02') {
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось добавить вложение' });
        }
    } finally {
        if (client) {
            client.release();
        }
    }
};

// Функция для получения списка вложений задачи
export const getTaskAttachments = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { id: taskId } = req.params;

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }
    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }

    try {
        // 1. Проверяем существование задачи и права доступа
        const taskResult = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskResult.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            return;
        }
        const task = taskResult.rows[0];
        if (task.creator_id !== userId && task.assignee_id !== userId) {
            res.status(403).json({ error: 'У вас нет прав на просмотр вложений этой задачи.' });
            return;
        }

        // 2. Получаем список вложений
        const attachmentsResult = await pool.query(
            'SELECT * FROM task_attachments WHERE task_id = $1 ORDER BY created_at ASC',
            [taskId]
        );

        // Добавляем URL для скачивания (если это необходимо фронтенду)
        // const attachmentsWithUrl = attachmentsResult.rows.map(att => ({
        //     ...att,
        //     download_url: `/uploads/${att.file_path}` // Путь зависит от настройки статики в Express
        // }));

        res.status(200).json(attachmentsResult.rows); // Возвращаем просто данные из БД
        console.log(`Получены вложения для задачи ${taskId} пользователем ${userId}.`);

    } catch (error: any) { // Указываем тип any
        console.error(`Ошибка при получении вложений для задачи ${taskId}:`, error);
        if (error.code === '22P02') {
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось получить вложения' });
        }
    }
};


// Функция для получения логов изменений задачи
export const getTaskLogs = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id; // ID текущего пользователя
    const { id: taskId } = req.params; // ID задачи из URL

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }
    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }

    try {
        // 1. Проверяем существование задачи и права доступа (создатель или исполнитель)
        const taskResult = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskResult.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            return;
        }
        const task = taskResult.rows[0];
        if (task.creator_id !== userId && task.assignee_id !== userId) {
            res.status(403).json({ error: 'У вас нет прав на просмотр истории изменений этой задачи.' });
            return;
        }

        // 2. Получаем логи изменений, присоединяя имя пользователя
        const logsResult = await pool.query(
            `SELECT tl.*, u.username AS changed_by_username
             FROM task_logs tl
             LEFT JOIN users u ON tl.changed_by = u.id -- LEFT JOIN на случай, если пользователь удален
             WHERE tl.task_id = $1
             ORDER BY tl.changed_at DESC`, // Сортируем от новых к старым
            [taskId]
        );

        res.status(200).json(logsResult.rows);
        console.log(`Получена история изменений для задачи ${taskId} пользователем ${userId}.`);

    } catch (error: any) { // Указываем тип any
        console.error(`Ошибка при получении логов для задачи ${taskId}:`, error);
        if (error.code === '22P02') {
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось получить историю изменений' });
        }
    }
};

// Конец TODO для taskController

