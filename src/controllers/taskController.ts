import { Request, Response } from 'express';
import pool from '../models/db';
import { PoolClient } from 'pg'; // Импортируем PoolClient для транзакций
import path from 'path'; // Добавляем импорт path
import fs from 'fs'; // Добавляем импорт fs
// import { io } from '../index'; // Убираем прямой импорт io
import * as socketService from '../services/socketService'; // Импортируем сервис

// Remove SERVER_BASE_URL and getAbsoluteUrl
// const HOST = process.env.HOST || 'localhost';
// const PORT = process.env.PORT || 6000;
// const SERVER_BASE_URL = `http://${HOST}:${PORT}`;

// Function to construct absolute URL from relative path - REMOVED
// const getAbsoluteUrl = (relativePath: string | null): string | null => {
//     return relativePath ? `${SERVER_BASE_URL}${relativePath}` : null;
// };

// Интерфейс для пользователя из req.user (допустим, он есть)
interface AuthenticatedUser {
    id: string;
    username: string;
    // Другие поля, если есть (например, isAdmin)
}

// Helper function to get user details (avoids repetition)
const getUserDetails = async (userId: string | null | undefined, client?: PoolClient): Promise<{ id: string | null | undefined, username: string | null }> => {
    if (!userId) return { id: userId, username: null };
    const queryRunner = client || pool;
    try {
        const userResult = await queryRunner.query('SELECT username FROM users WHERE id = $1', [userId]);
        return {
            id: userId,
            username: userResult.rows.length > 0 ? userResult.rows[0].username : null,
        };
    } catch (error) {
        console.error(`Error fetching username for user ${userId}:`, error);
        return { id: userId, username: null }; // Return ID even if username fetch fails
    }
};

// Helper function to get user details WITH avatar (returns absolute URL) -> MODIFIED
const getUserDetailsWithAvatar = async (userId: string | null | undefined, client?: PoolClient): Promise<{ id: string | null | undefined, username: string | null, avatarPath: string | null }> => {
    if (!userId) return { id: userId, username: null, avatarPath: null };
    const queryRunner = client || pool;
    try {
        const userResult = await queryRunner.query(
            `SELECT u.username, ua.file_path AS "avatarPath"
             FROM users u
             LEFT JOIN user_avatars ua ON u.id = ua.user_id
             WHERE u.id = $1`,
            [userId]
        );
        const relativePath = userResult.rows.length > 0 ? userResult.rows[0].avatarPath : null;
        return {
            id: userId,
            username: userResult.rows.length > 0 ? userResult.rows[0].username : null,
            // avatarUrl: getAbsoluteUrl(relativePath), // Construct absolute URL here - REMOVED
            avatarPath: relativePath // Return relative path directly
        };
    } catch (error) {
        console.error(`Error fetching username/avatar for user ${userId}:`, error);
        return { id: userId, username: null, avatarPath: null }; // Return null path on error
    }
};

// Функция для создания новой задачи
export const createTask = async (req: Request, res: Response): Promise<void> => {
    const { title, description, status, priority, assignee_id, due_date } = req.body;
    const creator_id = req.user?.id;

    if (!title || !creator_id) {
        res.status(400).json({ error: 'Необходимо указать название задачи и ID создателя.' });
        return;
    }

    try {
        const result = await pool.query(
            `INSERT INTO tasks (title, description, status, priority, creator_id, assignee_id, due_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`, // Возвращаем созданную задачу
            [title, description, status || 'open', priority || 3, creator_id, assignee_id, due_date]
        );

        const newTask = result.rows[0];

        // Fetch usernames and avatars for the event payload
        const creatorDetails = await getUserDetailsWithAvatar(newTask.creator_id);
        const assigneeDetails = await getUserDetailsWithAvatar(newTask.assignee_id);

        // Emit event to general tasks room
        const eventPayload = {
            ...newTask,
            creator_username: creatorDetails.username,
            assignee_username: assigneeDetails.username,
            creatorAvatarPath: creatorDetails.avatarPath, // Added creator avatar path
            assigneeAvatarPath: assigneeDetails.avatarPath, // Added assignee avatar path
            due_date: newTask.due_date ? new Date(newTask.due_date).toISOString() : null,
            created_at: new Date(newTask.created_at).toISOString(),
            updated_at: new Date(newTask.updated_at).toISOString(),
        };
        socketService.emitToRoom('general_tasks', 'newTaskCreated', eventPayload);

        res.status(201).json(newTask); // Send back the raw task data
        console.log(`Задача "${title}" (ID: ${newTask.id}) создана пользователем ${creator_id}`);

    } catch (error: any) {
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
                   assignee.username AS assignee_username,
                   creator_avatar.file_path AS "creatorAvatarPath", -- Relative path
                   assignee_avatar.file_path AS "assigneeAvatarPath" -- Relative path
            FROM tasks t
            LEFT JOIN users creator ON t.creator_id = creator.id
            LEFT JOIN users assignee ON t.assignee_id = assignee.id
            LEFT JOIN user_avatars creator_avatar ON t.creator_id = creator_avatar.user_id
            LEFT JOIN user_avatars assignee_avatar ON t.assignee_id = assignee_avatar.user_id
            WHERE (t.creator_id = $1 OR t.assignee_id = $1)
        `;
        const queryParams: any[] = [userId];
        let paramIndex = 2; // Начинаем со второго параметра ($2)

        if (status) {
            queryText += ` AND t.status = $${paramIndex++}`;
            queryParams.push(status);
        }

        if (search) {
            queryText += ` AND (t.title ILIKE $${paramIndex} OR t.description ILIKE $${paramIndex})`;
            queryParams.push(`%${search}%`);
        }

        queryText += ` ORDER BY t.created_at DESC`;

        const result = await pool.query(queryText, queryParams);

        const tasksWithAbsoluteUrls = result.rows.map(task => ({
            ...task,
            // creatorAvatarUrl: getAbsoluteUrl(task.creatorAvatarPath),
            // assigneeAvatarUrl: getAbsoluteUrl(task.assigneeAvatarPath),
            due_date: task.due_date ? new Date(task.due_date).toISOString() : null,
            created_at: new Date(task.created_at).toISOString(),
            updated_at: new Date(task.updated_at).toISOString(),
            // creatorAvatarPath: undefined, // Keep relative paths
            // assigneeAvatarPath: undefined
        }));

        res.status(200).json(tasksWithAbsoluteUrls);
        console.log(`Получен список задач для пользователя ${userId} с фильтрами: status=${status}, search=${search}`);

    } catch (error: any) {
        console.error('Ошибка при получении списка задач:', error);
        res.status(500).json({ error: 'Не удалось получить список задач' });
    }
};

// Функция для получения задачи по ID
export const getTaskById = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id; // ID текущего пользователя
    const { taskId } = req.body; // ID из тела

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId || typeof taskId !== 'string') {
        res.status(400).json({ error: 'Не указан ID задачи (taskId) в теле запроса.' });
        return;
    }

    try {
        const queryText = `
            SELECT t.*, 
                   creator.username AS creator_username, 
                   assignee.username AS assignee_username,
                   creator_avatar.file_path AS "creatorAvatarPath", -- Relative path
                   assignee_avatar.file_path AS "assigneeAvatarPath" -- Relative path
            FROM tasks t
            LEFT JOIN users creator ON t.creator_id = creator.id
            LEFT JOIN users assignee ON t.assignee_id = assignee.id
            LEFT JOIN user_avatars creator_avatar ON t.creator_id = creator_avatar.user_id
            LEFT JOIN user_avatars assignee_avatar ON t.assignee_id = assignee_avatar.user_id
            WHERE t.id = $1
        `;
        
        const result = await pool.query(queryText, [taskId]);

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка доступа к несуществующей задаче ID: ${taskId} пользователем ${userId}`);
            return;
        }

        const task = result.rows[0];

        if (task.creator_id !== userId && task.assignee_id !== userId) {
            res.status(403).json({ error: 'Доступ к этой задаче запрещен.' });
            console.log(`Пользователь ${userId} пытался получить доступ к задаче ${taskId}, к которой не имеет отношения.`);
            return;
        }

        const taskWithAbsoluteUrls = {
            ...task,
            // creatorAvatarUrl: getAbsoluteUrl(task.creatorAvatarPath),
            // assigneeAvatarUrl: getAbsoluteUrl(task.assigneeAvatarPath),
            due_date: task.due_date ? new Date(task.due_date).toISOString() : null,
            created_at: new Date(task.created_at).toISOString(),
            updated_at: new Date(task.updated_at).toISOString(),
            // creatorAvatarPath: undefined,
            // assigneeAvatarPath: undefined
        };

        res.status(200).json(taskWithAbsoluteUrls);
        console.log(`Получена задача ID: ${taskId} пользователем ${userId}`);

    } catch (error: any) {
        console.error(`Ошибка при получении задачи ID ${taskId}:`, error);
        if (error.code === '22P02') { 
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось получить задачу' });
        }
    }
};

// Функция для обновления задачи
export const updateTask = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id;
    const { taskId, ...updates } = req.body; // Получаем taskId и остальные обновления из тела

    console.log(`Попытка обновления задачи ID: ${taskId} (из тела) пользователем ${userId}. Данные:`, updates);

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId || typeof taskId !== 'string') {
        res.status(400).json({ error: 'Не указан ID задачи (taskId) в теле запроса.' });
        return;
    }

    if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'Нет данных для обновления.' });
        return;
    }

    const allowedUpdates = ['title', 'description', 'status', 'priority', 'assignee_id', 'due_date'];
    const updatesToApply: { [key: string]: any } = {};
    const logEntriesData: Array<{ action: string, old_value: string, new_value: string }> = [];

    Object.keys(updates).forEach(key => {
        if (allowedUpdates.includes(key)) {
            updatesToApply[key] = updates[key];
        }
    });

    if (Object.keys(updatesToApply).length === 0) {
        res.status(400).json({ error: 'Переданы недопустимые поля для обновления.' });
        return;
    }

    let client: PoolClient | null = null;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // Получаем текущее состояние задачи перед обновлением для логирования и проверки доступа
        const currentTaskResult = await client.query(
            `SELECT t.*, creator.username AS creator_username, assignee.username AS assignee_username
             FROM tasks t
             LEFT JOIN users creator ON t.creator_id = creator.id
             LEFT JOIN users assignee ON t.assignee_id = assignee.id
             WHERE t.id = $1`,
            [taskId]
        );

        if (currentTaskResult.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Задача для обновления не найдена.' });
            return;
        }
        const currentTask = currentTaskResult.rows[0];

        // Проверка прав: обновлять может создатель или назначенный исполнитель
        if (currentTask.creator_id !== userId && currentTask.assignee_id !== userId) {
            await client.query('ROLLBACK');
            res.status(403).json({ error: 'Вы не можете обновлять эту задачу.' });
            return;
        }

        // Формируем строку запроса и параметры для обновления
        let setClauses: string[] = [];
        let queryParams: any[] = [taskId, userId]; // userId для WHERE в логах
        let paramIndex = 3;

        Object.keys(updatesToApply).forEach(key => {
            const oldValue = currentTask[key];
            const newValue = updatesToApply[key];
            
            // Сравниваем значения, чтобы логировать только реальные изменения
            // Обработка дат: преобразуем в строки ISO для сравнения
            const oldValueStr = oldValue instanceof Date ? oldValue.toISOString() : String(oldValue);
            const newValueStr = newValue instanceof Date ? newValue.toISOString() : String(newValue); // Обработка null/undefined

            if (oldValueStr !== newValueStr) {
                 setClauses.push(`${key} = $${paramIndex}`);
                 queryParams.push(newValue);

                 let actionText = `Изменено поле ${key}`;
                 if (key === 'assignee_id') actionText = 'Изменен исполнитель';
                 if (key === 'status') actionText = 'Изменен статус';
                 if (key === 'priority') actionText = 'Изменен приоритет';
                 if (key === 'due_date') actionText = 'Изменен срок выполнения';

                 logEntriesData.push({
                     action: actionText,
                     old_value: oldValueStr, // Log original value
                     new_value: newValueStr ?? 'null' // Log new value or 'null'
                 });
                 paramIndex++;
            }
        });

        // If no actual changes detected based on value comparison
        if (setClauses.length === 0) {
            await client.query('ROLLBACK');
            // Fetch current details for the response even if no update occurred
            const creatorDetailsNoChange = await getUserDetailsWithAvatar(currentTask.creator_id, client);
            const assigneeDetailsNoChange = await getUserDetailsWithAvatar(currentTask.assignee_id, client);
            const noChangeResponse = {
                ...currentTask,
                creator_username: creatorDetailsNoChange.username,
                assignee_username: assigneeDetailsNoChange.username,
                creatorAvatarPath: creatorDetailsNoChange.avatarPath,
                assigneeAvatarPath: assigneeDetailsNoChange.avatarPath,
                due_date: currentTask.due_date ? new Date(currentTask.due_date).toISOString() : null,
                created_at: new Date(currentTask.created_at).toISOString(),
                updated_at: new Date(currentTask.updated_at).toISOString(),
                // creatorAvatarPath: undefined,
                // assigneeAvatarPath: undefined
            };
            res.status(200).json({ message: 'Нет изменений для применения.', task: noChangeResponse });
            console.log(`Task ${taskId} update requested by ${userId}, but no actual changes detected.`);
            return;
        }

        // Prepare parameters specifically for the UPDATE query and the SET clauses
        const updateQueryParams = [taskId]; // $1 = taskId
        let placeholderIndex = 2; // Placeholders for updated values start from $2
        const updateSetClauses: string[] = []; // Use a new array for correct SET clauses

        Object.keys(updatesToApply).forEach(key => {
            // Only add values/clauses that actually changed
            const oldValue = currentTask[key];
            const newValue = updatesToApply[key];
            const oldValueStr = oldValue instanceof Date ? oldValue.toISOString() : String(oldValue);
            const newValueStr = newValue instanceof Date ? newValue.toISOString() : String(newValue);

            if (oldValueStr !== newValueStr) {
                 updateQueryParams.push(newValue); // Add the value to the parameter array
                 updateSetClauses.push(`${key} = $${placeholderIndex}`); // Add the clause with the correct placeholder index
                 placeholderIndex++; // Increment index for the next parameter
            }
        });

        // Включаем updated_at в запрос (не требует параметра)
        updateSetClauses.push(`updated_at = CURRENT_TIMESTAMP`);
        
        // Construct the query using the correctly generated SET clauses
        const updateQuery = `UPDATE tasks SET ${updateSetClauses.join(', ')} WHERE id = $1 RETURNING *`;

        // Execute UPDATE with its specific parameters
        const updatedResult = await client.query(updateQuery, updateQueryParams);
        const updatedTask = updatedResult.rows[0];

        // Создаем записи в логах using [taskId, userId]
        if (logEntriesData.length > 0) {
            const logValues = logEntriesData.map(log =>
                `($1, '${log.action.replace(/'/g, "''")}', '${String(log.old_value).replace(/'/g, "''")}', '${String(log.new_value).replace(/'/g, "''")}', $2)`
            ).join(',');
            const logQuery = `INSERT INTO task_logs (task_id, action, old_value, new_value, changed_by) VALUES ${logValues}`;
            // Pass [taskId, userId] for the log query
            await client.query(logQuery, [taskId, userId]); 
        }

        await client.query('COMMIT');

        // --- WebSocket Event --- 
        // Fetch usernames and avatars for the updated task
        const creatorDetails = await getUserDetailsWithAvatar(updatedTask.creator_id, client);
        const assigneeDetails = await getUserDetailsWithAvatar(updatedTask.assignee_id, client);
        const changerDetails = await getUserDetailsWithAvatar(userId, client); // User who made the change

        const eventPayload = {
            ...updatedTask,
            creator_username: creatorDetails.username,
            assignee_username: assigneeDetails.username,
            creatorAvatarPath: creatorDetails.avatarPath, // Pass relative path
            assigneeAvatarPath: assigneeDetails.avatarPath, // Pass relative path
            // Details about the change
            change_details: logEntriesData, // Send detailed changes
            changed_by: {
                user_id: changerDetails.id,
                username: changerDetails.username,
                // avatarUrl: changerDetails.avatarUrl, // Use path instead
                avatarPath: changerDetails.avatarPath // Pass relative path
            },
            // Ensure dates are in ISO 8601 format
            due_date: updatedTask.due_date ? new Date(updatedTask.due_date).toISOString() : null,
            created_at: new Date(updatedTask.created_at).toISOString(),
            updated_at: new Date(updatedTask.updated_at).toISOString(),
        };
        
        // Emit to the specific task room and general tasks room
        const taskRoom = `task_${taskId}`;
        socketService.emitToRoom(taskRoom, 'taskUpdated', eventPayload);
        socketService.emitToRoom('general_tasks', 'taskUpdated', eventPayload); // Also notify the list view
        console.log(`Event taskUpdated emitted for task ${taskId} to rooms ${taskRoom} and general_tasks`);
        // ---

        // Construct the response object with absolute URLs and correct date formats
        const responseTask = {
            ...updatedTask,
            creator_username: creatorDetails.username,
            assignee_username: assigneeDetails.username,
            creatorAvatarPath: creatorDetails.avatarPath,
            assigneeAvatarPath: assigneeDetails.avatarPath,
            due_date: updatedTask.due_date ? new Date(updatedTask.due_date).toISOString() : null,
            created_at: new Date(updatedTask.created_at).toISOString(),
            updated_at: new Date(updatedTask.updated_at).toISOString(),
            // Remove potentially existing relative paths if they were selected - NO, KEEP THEM
            // creatorAvatarPath: undefined,
            // assigneeAvatarPath: undefined
        };

        res.status(200).json(responseTask); // Send the formatted task object
        console.log(`Задача ID: ${taskId} успешно обновлена пользователем ${userId}`);

    } catch (error: any) {
        if (client) {
            await client.query('ROLLBACK');
        }
        console.error(`Ошибка при обновлении задачи ID ${taskId}:`, error);
         if (error.code === '22P02') { 
             res.status(400).json({ error: 'Неверный формат ID задачи или исполнителя.' });
         } else if (error.code === '23503') { // Foreign key violation (e.g., assignee_id doesn't exist)
              res.status(400).json({ error: 'Указанный исполнитель не найден.' });
         } else {
             res.status(500).json({ error: 'Не удалось обновить задачу' });
         }
    } finally {
        if (client) {
            client.release();
        }
    }
};

// Функция для удаления задачи
export const deleteTask = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id;
    const { taskId } = req.body; // Новый способ

    console.log(`Попытка удаления задачи ID: ${taskId} (из тела) пользователем ${userId}.`);

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId || typeof taskId !== 'string') {
        res.status(400).json({ error: 'Не указан ID задачи (taskId) в теле запроса.' });
        return;
    }

    let client: PoolClient | null = null;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // 1. Проверяем существование задачи и права доступа
        const taskResult = await client.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);

        if (taskResult.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка удалить несуществующую задачу ID: ${taskId} пользователем ${userId}`);
            client.release();
            return;
        }

        const task = taskResult.rows[0];
        // Проверка прав: удалить может только создатель (или администратор - логику можно добавить)
        // if (task.creator_id !== userId) {
        //     await client.query('ROLLBACK');
        //     res.status(403).json({ error: 'У вас нет прав на удаление этой задачи.' });
        //     console.log(`Пользователь ${userId} пытался удалить задачу ${taskId}, созданную ${task.creator_id}.`);
        //     client.release();
        // }

        // 2. Удаляем связанные данные (логи, комментарии, вложения) - каскадное удаление настроено в БД,
        // но вложения на диске нужно удалить вручную.

        // Получаем пути к файлам вложений перед удалением задачи из БД
        const attachmentsResult = await client.query('SELECT file_path FROM task_attachments WHERE task_id = $1', [taskId]);
        const filePathsToDelete = attachmentsResult.rows.map(row => row.file_path);

        // 3. Удаляем саму задачу
        const deleteResult = await client.query('DELETE FROM tasks WHERE id = $1 RETURNING id', [taskId]);

        if (deleteResult.rowCount === 0) {
            // Это не должно произойти, если проверка выше прошла, но на всякий случай
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Не удалось найти задачу для удаления после проверки.' });
             console.error(`Не удалось найти задачу ${taskId} для удаления после проверки.`);
             client.release();
            return;
        }

        // 4. Удаляем файлы с диска
        for (const filePath of filePathsToDelete) {
            const fullPath = path.resolve(filePath); // Убедимся, что путь абсолютный
             try {
                 if (fs.existsSync(fullPath)) {
                     fs.unlinkSync(fullPath);
                     console.log(`Файл вложения удален с диска: ${fullPath}`);
                 }
             } catch (fsError) {
                 console.error(`Ошибка при удалении файла вложения ${fullPath} с диска:`, fsError);
                 // Не прерываем процесс из-за ошибки удаления файла, но логируем
             }
        }

        await client.query('COMMIT');

        // Emit deletion event
        const eventPayloadDelete = { taskId: taskId };
        const taskRoomDelete = `task_${taskId}`;
        socketService.emitToRoom(taskRoomDelete, 'taskDeleted', eventPayloadDelete);
        console.log(`Event taskDeleted emitted for task ${taskId} to task_${taskId}`);

        res.status(200).json({ message: 'Задача и все связанные данные успешно удалены.', taskId: taskId });
        console.log(`Задача ID: ${taskId} успешно удалена пользователем ${userId}.`);

    } catch (error: any) {
        if (client) {
            await client.query('ROLLBACK');
            console.error(`Транзакция удаления задачи ${taskId} отменена из-за ошибки.`);
        }
        console.error(`Ошибка при удалении задачи ID ${taskId}:`, error);
        if (error.code === '22P02') { // Invalid UUID format
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось удалить задачу' });
        }
    } finally {
        if (client) {
            client.release();
            console.log(`Клиент базы данных освобожден после удаления задачи ${taskId}.`);
        }
    }
};

// --- Комментарии к задачам ---

// Функция для добавления комментария к задаче
export const addTaskComment = async (req: Request, res: Response): Promise<void> => {
    const commenter_id = req.user?.id;
    const { taskId, comment } = req.body; // taskId from body

    console.log(`Попытка добавить комментарий к задаче ID: ${taskId} пользователем ${commenter_id}`);

    if (!commenter_id) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }
    if (!taskId || !comment || typeof taskId !== 'string') {
        res.status(400).json({ error: 'Не указан ID задачи (taskId) или текст комментария в теле запроса.' });
        return;
    }

    try {
        // Verify task exists and user has access (optional, but good practice)
        const taskCheck = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskCheck.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            return;
        }
        // Add access check if needed, e.g.:
        // const taskData = taskCheck.rows[0];
        // if (taskData.creator_id !== commenter_id && taskData.assignee_id !== commenter_id) {
        //     res.status(403).json({ error: 'Вы не можете комментировать эту задачу.' });
        //     return;
        // }

        const result = await pool.query(
            'INSERT INTO task_comments (task_id, commenter_id, comment) VALUES ($1, $2, $3) RETURNING *'
            , [taskId, commenter_id, comment]
        );
        const newComment = result.rows[0];

        // --- WebSocket Event ---
        // Fetch commenter details (username, avatar)
        const commenterDetails = await getUserDetailsWithAvatar(newComment.commenter_id);
        const eventPayload = {
            ...newComment,
            commenter_username: commenterDetails.username,
            // commenterAvatarUrl: commenterDetails.avatarUrl, // Use path instead
            commenterAvatarPath: commenterDetails.avatarPath, // Added commenter avatar path
            created_at: new Date(newComment.created_at).toISOString() // Ensure ISO format
        };
        const taskRoom = `task_${taskId}`;
        socketService.emitToRoom(taskRoom, 'newTaskComment', eventPayload);
        console.log(`Event newTaskComment emitted for task ${taskId} to room ${taskRoom}`);
        // ---

        res.status(201).json(newComment);
        console.log(`Комментарий к задаче ${taskId} добавлен пользователем ${commenter_id}`);

    } catch (error: any) {
        console.error(`Ошибка при добавлении комментария к задаче ${taskId}:`, error);
        if (error.code === '23503') { // Foreign key violation
            res.status(404).json({ error: 'Задача или пользователь не найдены.' });
        } else if (error.code === '22P02') { 
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось добавить комментарий' });
        }
    }
};

// Функция для получения комментариев к задаче
export const getTaskComments = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { taskId } = req.params; // taskId from URL parameters

    console.log(`Попытка получить комментарии к задаче ID: ${taskId} пользователем ${userId}`);

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }
    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи в параметрах URL.' });
        return;
    }

    try {
         // Verify user has access to the task (optional but recommended)
         const taskCheck = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
         if (taskCheck.rows.length === 0) {
             res.status(404).json({ error: 'Задача не найдена.' });
             return;
         }
         // const taskData = taskCheck.rows[0];
         // if (taskData.creator_id !== userId && taskData.assignee_id !== userId) {
         //     res.status(403).json({ error: 'Вы не можете просматривать комментарии к этой задаче.' });
         //     return;
         // }

        const result = await pool.query(
            `
            SELECT tc.*, 
                   u.username AS commenter_username,
                   ua.file_path AS "commenterAvatarPath" -- Relative path
            FROM task_comments tc
            LEFT JOIN users u ON tc.commenter_id = u.id
            LEFT JOIN user_avatars ua ON tc.commenter_id = ua.user_id
            WHERE tc.task_id = $1 
            ORDER BY tc.created_at ASC
            `,
            [taskId]
        );

        const commentsWithAbsoluteUrls = result.rows.map(comment => ({
            ...comment,
            // commenterAvatarUrl: getAbsoluteUrl(comment.commenterAvatarPath),
            created_at: new Date(comment.created_at).toISOString(),
            // commenterAvatarPath: undefined // Keep relative path
        }));

        res.status(200).json(commentsWithAbsoluteUrls);
        console.log(`Получены комментарии к задаче ${taskId}`);

    } catch (error: any) {
        console.error(`Ошибка при получении комментариев к задаче ${taskId}:`, error);
        if (error.code === '22P02') { 
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось получить комментарии' });
        }
    }
};

// --- Вложения к задачам ---

// Функция для добавления вложения к задаче
export const addTaskAttachment = async (req: Request, res: Response): Promise<void> => {
    const uploader_id = req.user?.id;
    const { taskId } = req.body; // Ожидаем taskId в теле form-data 
    const file = req.file; // Получаем файл из multer

    console.log(`Попытка добавить вложение к задаче ID: ${taskId} пользователем ${uploader_id}. Файл:`, file);

    if (!uploader_id) {
        // Если файл был загружен, но пользователь не аутентифицирован, удаляем файл
        if (file) fs.unlinkSync(file.path);
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId || typeof taskId !== 'string') {
        if (file) fs.unlinkSync(file.path);
        res.status(400).json({ error: 'Не указан ID задачи (taskId) в теле запроса (form-data).' });
        return;
    }

    if (!file) {
        res.status(400).json({ error: 'Файл не был загружен.' });
        return;
    }

    let client: PoolClient | null = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // 1. Проверяем существование задачи и права доступа (добавлять может создатель или исполнитель)
        const taskResult = await client.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskResult.rows.length === 0) {
            await client.query('ROLLBACK');
            fs.unlinkSync(file.path); // Удаляем загруженный файл, т.к. задача не найдена
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка добавить вложение к несуществующей задаче ID: ${taskId} пользователем ${uploader_id}`);
            client.release();
            return;
        }
        // const task = taskResult.rows[0];
        // if (task.creator_id !== uploader_id && task.assignee_id !== uploader_id) {
        //     await client.query('ROLLBACK');
        //     fs.unlinkSync(file.path); // Удаляем файл, т.к. нет прав
        //     res.status(403).json({ error: 'У вас нет прав добавлять вложения к этой задаче.' });
        //     console.log(`Пользователь ${uploader_id} пытался добавить вложение к задаче ${taskId}, к которой не имеет отношения.`);
        //     client.release();
        // }

        // 2. Сохраняем информацию о файле в БД
        const { originalname, path: filePath, mimetype, size } = file;
        const insertResult = await client.query(
            `INSERT INTO task_attachments (task_id, file_name, file_path, file_type, file_size, uploader_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [taskId, originalname, filePath, mimetype, size, uploader_id]
        );
        const newAttachment = insertResult.rows[0];

        await client.query('COMMIT');

         // Fetch uploader username for the event payload
        const uploaderDetails = await getUserDetails(newAttachment.uploader_id); // Fetch outside transaction

        // Emit event to the specific task room
        const eventPayload = {
            id: newAttachment.id,
            task_id: newAttachment.task_id,
            file_name: newAttachment.file_name,
            file_type: newAttachment.file_type,
            // file_size: newAttachment.file_size, // Старое поле
            file_size_bytes: newAttachment.file_size, // Новое поле
            // upload_date: new Date(newAttachment.created_at).toISOString(), // Старое поле
            uploaded_at: new Date(newAttachment.created_at).toISOString(), // Новое поле
            // uploaded_by: newAttachment.uploader_id, // Старое поле
            uploaded_by_id: newAttachment.uploader_id, // Новое поле
            uploaded_by_username: uploaderDetails.username,
            // Убираем download_url, так как клиент его формирует сам
            // download_url: `/tasks/${taskId}/attachments/${newAttachment.id}/download` 
        };
        const attachmentTargetRoom = `task_${taskId}`;
        // console.log(`[Socket Emit] Event: newTaskAttachment | Target: Room ${attachmentTargetRoom}`); // Лог внутри сервиса
        // io.to(attachmentTargetRoom).emit('newTaskAttachment', eventPayload);
        socketService.emitToRoom(attachmentTargetRoom, 'newTaskAttachment', eventPayload);
        // console.log(`Event newTaskAttachment emitted for task ${taskId}, attachment ${newAttachment.id}`);

        res.status(201).json(eventPayload); // Возвращаем информацию о добавленном вложении
        console.log(`Вложение ID ${newAttachment.id} добавлено к задаче ${taskId} пользователем ${uploader_id}.`);

    } catch (error: any) {
        if (client) {
            await client.query('ROLLBACK');
            console.error(`Транзакция добавления вложения к задаче ${taskId} отменена из-за ошибки.`);
        }
        // В случае ошибки БД, удаляем загруженный файл
        if (file) fs.unlinkSync(file.path);
        console.error(`Ошибка при добавлении вложения к задаче ${taskId}:`, error);
         if (error.code === '22P02') { // Invalid UUID format for task id
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else if (error.code === '23503') { // Foreign key violation (task_id or uploader_id)
             res.status(404).json({ error: 'Указана неверная задача или пользователь.' });
        } else {
            res.status(500).json({ error: 'Не удалось добавить вложение' });
        }
    } finally {
        if (client) {
            client.release();
            console.log(`Клиент базы данных освобожден после добавления вложения к задаче ${taskId}.`);
        }
    }
};

// Функция для получения списка вложений задачи
export const getTaskAttachments = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { taskId } = req.body; // Новый способ

    console.log(`Запрос вложений задачи ID: ${taskId} пользователем ${userId}.`);

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId || typeof taskId !== 'string') {
        res.status(400).json({ error: 'Не указан ID задачи (taskId) в теле запроса.' });
        return;
    }

    try {
        // 1. Проверяем существование задачи и права доступа (просматривать может создатель или исполнитель)
        const taskResult = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskResult.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка получить вложения несуществующей задачи ID: ${taskId} пользователем ${userId}`);
            return;
        }
        // const task = taskResult.rows[0];
        // if (task.creator_id !== userId && task.assignee_id !== userId) {
        //      res.status(403).json({ error: 'У вас нет прав просматривать вложения этой задачи.' });
        //      console.log(`Пользователь ${userId} пытался получить вложения задачи ${taskId}, к которой не имеет отношения.`);
        //     return;
        // }

        // 2. Получаем список вложений с именем загрузившего
        const attachmentsResult = await pool.query(
            `SELECT ta.*, u.username AS uploaded_by_username
             FROM task_attachments ta
             LEFT JOIN users u ON ta.uploader_id = u.id -- Use LEFT JOIN in case uploader is deleted
             WHERE ta.task_id = $1
             ORDER BY ta.created_at ASC`,
            [taskId]
        );

        // Формируем ответ с download_url
        const attachmentsWithDetails = attachmentsResult.rows.map(att => ({
            id: att.id,
            task_id: att.task_id,
            file_name: att.file_name,
            file_type: att.file_type,
            // file_size: att.file_size, // Старое поле
            file_size_bytes: att.file_size, // Новое поле
            // upload_date: new Date(att.created_at).toISOString(), // Старое поле
            uploaded_at: new Date(att.created_at).toISOString(), // Новое поле
            // uploaded_by: att.uploader_id, // Старое поле
            uploaded_by_id: att.uploader_id, // Новое поле
            uploaded_by_username: att.uploaded_by_username,
            // Убираем download_url
            // download_url: `/tasks/${taskId}/attachments/${att.id}/download`
        }));

        res.status(200).json(attachmentsWithDetails);
        console.log(`Получены вложения (${attachmentsResult.rowCount}) для задачи ${taskId} пользователем ${userId}.`);

    } catch (error: any) {
        console.error(`Ошибка при получении вложений задачи ${taskId}:`, error);
        if (error.code === '22P02') { // Invalid UUID format for task id
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось получить вложения' });
        }
    }
};

// Функция для скачивания вложения
export const downloadTaskAttachment = async (req: Request, res: Response): Promise<void> => {
     const userId = (req.user as AuthenticatedUser)?.id;
     const { attachmentId } = req.params; // Оставляем attachmentId из params

     console.log(`Запрос на скачивание вложения ID: ${attachmentId} пользователем ${userId}.`);

     if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!attachmentId || typeof attachmentId !== 'string') {
        res.status(400).json({ error: 'Не указан ID вложения (attachmentId) в параметрах URL.' });
        return;
    }

    try {
        // 1. Проверяем существование задачи и права доступа (скачивать может создатель или исполнитель)
         const taskResult = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [attachmentId]);
        if (taskResult.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
             console.log(`Попытка скачать вложение ${attachmentId} несуществующей задачи ${attachmentId} пользователем ${userId}`);
            return;
        }
        // const task = taskResult.rows[0];
        // if (task.creator_id !== userId && task.assignee_id !== userId) {
        //      res.status(403).json({ error: 'У вас нет прав скачивать вложения этой задачи.' });
        //      console.log(`Пользователь ${userId} пытался скачать вложение ${attachmentId} задачи ${taskId}, к которой не имеет отношения.`);
        //     return;
        // }

        // 2. Получаем информацию о файле
        const fileResult = await pool.query('SELECT file_path, file_name FROM task_attachments WHERE id = $1 AND task_id = $2', [attachmentId, attachmentId]);

        if (fileResult.rows.length === 0) {
            res.status(404).json({ error: 'Вложение не найдено для этой задачи.' });
            console.log(`Вложение ID ${attachmentId} не найдено для задачи ${attachmentId}.`);
            return;
        }

        const { file_path, file_name } = fileResult.rows[0];
        const absolutePath = path.resolve(file_path); // Убеждаемся, что путь абсолютный

         // Проверяем, существует ли файл на диске
        if (!fs.existsSync(absolutePath)) {
             console.error(`Файл вложения не найден на диске: ${absolutePath}`);
             res.status(404).json({ error: 'Файл вложения не найден на сервере.' });
             return;
        }

        // Отправляем файл пользователю
        res.download(absolutePath, file_name, (err) => {
            if (err) {
                console.error(`Ошибка при отправке файла ${absolutePath} пользователю ${userId}:`, err);
                // Не отправляем JSON ошибку, если заголовки уже были отправлены
                 if (!res.headersSent) {
                     res.status(500).send('Не удалось скачать файл.');
                 }
            } else {
                 console.log(`Файл ${file_name} (ID: ${attachmentId}) успешно отправлен пользователю ${userId}.`);
            }
        });

    } catch (error: any) {
        console.error(`Ошибка при скачивании вложения ${attachmentId} задачи ${attachmentId}:`, error);
        if (error.code === '22P02') { // Invalid UUID format
            res.status(400).json({ error: 'Неверный формат ID задачи или вложения.' });
        } else {
            res.status(500).json({ error: 'Не удалось обработать запрос на скачивание файла' });
        }
    }
};

// Функция для удаления вложения
export const deleteTaskAttachment = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
    // const { id: taskId, attachmentId } = req.params; // Старый способ
    const { attachmentId } = req.params; // attachmentId из params
    // Опционально: можно передавать taskId в теле, если нужно для доп. проверок, но пока не требуется

    // console.log(`Попытка удаления вложения ID: ${attachmentId} задачи ${taskId} пользователем ${userId}.`); // Старый лог
    console.log(`Попытка удаления вложения ID: ${attachmentId} (из params) пользователем ${userId}.`);

     if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!attachmentId || typeof attachmentId !== 'string') {
        res.status(400).json({ error: 'Не указан ID вложения (attachmentId) в параметрах URL.' });
        return;
    }

    let client: PoolClient | null = null;
    let filePathToDelete: string | null = null; // Сохраняем путь к файлу для удаления
    let deletedTaskId: string | null = null; // Объявляем taskId для использования в finally/catch

    try {
        client = await pool.connect();
        await client.query('BEGIN');

         // 1. Проверяем существование задачи и права доступа (удалять может создатель или исполнитель)
         //    А также получаем путь к файлу для удаления с диска
         const attachmentResult = await client.query(
            `SELECT ta.file_path, ta.uploader_id, t.creator_id, t.assignee_id, ta.task_id
             FROM task_attachments ta
             JOIN tasks t ON ta.task_id = t.id
             WHERE ta.id = $1`, // Новый запрос, task_id не нужен здесь для выборки
            [attachmentId]
        );

        if (attachmentResult.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Вложение не найдено или не принадлежит указанной задаче.' });
            console.log(`Попытка удалить несуществующее/неверное вложение ${attachmentId} задачи ${attachmentId}`);
            client.release();
            return;
        }

        const { file_path, uploader_id, creator_id, assignee_id, task_id } = attachmentResult.rows[0];
        filePathToDelete = path.resolve(file_path); // Получаем полный путь
        deletedTaskId = task_id; // Сохраняем ID задачи

        // Проверка прав: удалить может загрузивший, создатель задачи или исполнитель задачи
        // if (uploader_id !== userId && creator_id !== userId && assignee_id !== userId) {
        //     await client.query('ROLLBACK');
        //      res.status(403).json({ error: 'У вас нет прав на удаление этого вложения.' });
        //      console.log(`Пользователь ${userId} пытался удалить вложение ${attachmentId}, не имея прав.`);
        //      client.release();
        // }

        // 2. Удаляем запись из БД
        const deleteResult = await client.query('DELETE FROM task_attachments WHERE id = $1', [attachmentId]);

        if (deleteResult.rowCount === 0) {
             // Маловероятно после первой проверки, но все же
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Не удалось найти вложение для удаления после проверки.' });
            console.error(`Не удалось найти вложение ${attachmentId} для удаления после проверки.`);
            client.release();
            return;
        }

        // 3. Удаляем файл с диска
        try {
            if (fs.existsSync(filePathToDelete)) {
                fs.unlinkSync(filePathToDelete);
                console.log(`Файл вложения удален с диска: ${filePathToDelete}`);
            } else {
                 console.warn(`Файл вложения для удаления не найден на диске: ${filePathToDelete}`);
            }
        } catch (fsError) {
            console.error(`Ошибка при удалении файла вложения ${filePathToDelete} с диска (запись в БД уже удалена):`, fsError);
            // Не откатываем транзакцию, т.к. запись в БД уже удалена
        }

        await client.query('COMMIT');

        // Emit event to the specific task room
        const eventPayload = { id: attachmentId, taskId: deletedTaskId };
        const deleteAttachmentTargetRoom = `task_${deletedTaskId}`;
        // console.log(`[Socket Emit] Event: taskAttachmentDeleted | Target: Room ${deleteAttachmentTargetRoom}`); // Лог внутри сервиса
        // io.to(deleteAttachmentTargetRoom).emit('taskAttachmentDeleted', eventPayload);
        socketService.emitToRoom(deleteAttachmentTargetRoom, 'taskAttachmentDeleted', eventPayload);
        // console.log(`Event taskAttachmentDeleted emitted for task ${task_id}, attachment ${attachmentId}`);

        res.status(200).json({ message: 'Вложение успешно удалено.', taskId: deletedTaskId, attachmentId: attachmentId });
        console.log(`Вложение ID ${attachmentId} задачи ${deletedTaskId} успешно удалено пользователем ${userId}.`);

    } catch (error: any) {
         if (client) {
            await client.query('ROLLBACK');
             console.error(`Транзакция удаления вложения ${attachmentId} задачи ${deletedTaskId ?? '?'} отменена.`);
        }
        console.error(`Ошибка при удалении вложения ${attachmentId} задачи ${deletedTaskId ?? '?'}:`, error);
        if (error.code === '22P02') { // Invalid UUID format
            res.status(400).json({ error: 'Неверный формат ID задачи или вложения.' });
        } else {
            res.status(500).json({ error: 'Не удалось удалить вложение' });
        }
    } finally {
        if (client) {
            client.release();
             console.log(`Клиент базы данных освобожден после удаления вложения ${attachmentId} задачи ${deletedTaskId ?? '?'}.`); // Используем deletedTaskId
        }
    }
};

// --- Логи изменений задач ---

// Функция для маппинга action в field_changed
const mapActionToFieldChanged = (action: string): string | null => {
    if (action.startsWith('update_')) {
        return action.substring(7); // Возвращаем имя поля после 'update_'
    }
    // Можно добавить обработку других типов action, если нужно
    // Например, 'create_task', 'add_comment', 'delete_attachment' и т.д.
    return action; // Возвращаем сам action если это не обновление поля
};

// Функция для получения логов задачи
export const getTaskLogs = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id;
    // const { id: taskId } = req.params; // Старый способ
    const { taskId } = req.body; // Новый способ

    // console.log(`Запрос логов задачи ID: ${taskId} пользователем ${userId}.`); // Старый лог
    console.log(`Запрос логов задачи ID: ${taskId} (из тела) пользователем ${userId}.`);

     if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    // if (!taskId) { // Старая проверка
    if (!taskId || typeof taskId !== 'string') { // Новая проверка
        res.status(400).json({ error: 'Не указан ID задачи (taskId) в теле запроса.' });
        return;
    }

    try {
        // 1. Проверяем существование задачи и права доступа (просматривать может создатель или исполнитель)
        const taskResult = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskResult.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка получить логи несуществующей задачи ID: ${taskId} пользователем ${userId}`);
            return;
        }
        // const task = taskResult.rows[0];
        // if (task.creator_id !== userId && task.assignee_id !== userId) {
        //     res.status(403).json({ error: 'У вас нет прав просматривать логи этой задачи.' });
        //     console.log(`Пользователь ${userId} пытался получить логи задачи ${taskId}, к которой не имеет отношения.`);
        //     return;
        // }

        // 2. Получаем логи с именем изменившего пользователя
        const logsResult = await pool.query(
            `SELECT tl.*, u.username AS changed_by_username
             FROM task_logs tl
             LEFT JOIN users u ON tl.changed_by = u.id -- Use LEFT JOIN in case user is deleted
             WHERE tl.task_id = $1
             ORDER BY tl.changed_at DESC`,
            [taskId]
        );

        // Ensure dates are in ISO 8601 format and log_id field is present
        const logsWithDetails = logsResult.rows.map(log => ({
            // log_id: log.id, // Старое поле
            logId: log.id, // Новое поле - соответствует LogEntryModel
            task_id: log.task_id,
            action: log.action, // Оставляем оригинальный action
            field_changed: mapActionToFieldChanged(log.action), // Новое поле
            old_value: log.old_value,
            new_value: log.new_value,
            // changed_by: log.changed_by, // Старое поле
            user_id: log.changed_by, // Новое поле - соответствует LogEntryModel
            // changed_by_username: log.changed_by_username, // Старое поле
            username: log.changed_by_username, // Новое поле - соответствует LogEntryModel
            // changed_at: new Date(log.changed_at).toISOString(), // Старое поле
            timestamp: new Date(log.changed_at).toISOString(), // Новое поле - соответствует LogEntryModel
        }));

        res.status(200).json(logsWithDetails);
        console.log(`Получены логи (${logsResult.rowCount}) для задачи ${taskId} пользователем ${userId}.`);

    } catch (error: any) {
        console.error(`Ошибка при получении логов задачи ${taskId}:`, error);
         if (error.code === '22P02') { // Invalid UUID format for task id
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось получить логи задачи' });
        }
    }
};

// Новый контроллер для генерации отчета по задачам
export const generateTaskReport = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id; // Используем тип

    // 1. Проверка аутентификации
    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    // 2. Распарсить параметры фильтрации из req.query
    const { 
        startDate, endDate, 
        status, priority, 
        assigneeId, creatorId, 
        // Новые фильтры:
        dueDateStart, dueDateEnd, dueDateFilter, // Фильтры по сроку выполнения
        updatedBeforeDays // Фильтр для "застрявших" задач
    } = req.query;

    console.log(`Запрос отчета по задачам от пользователя ${userId} с фильтрами:`, req.query);

    try {
         // ---- Предварительная обработка фильтров ----
         const filters: any = {};
         const queryParams: any[] = [];
         let paramIndex = 1;

         // Права доступа (пока пользователь видит только те задачи, где он создатель или исполнитель)
         // TODO: Расширить логику для админов или других ролей, если нужно
         const accessClause = `(t.creator_id = $${paramIndex} OR t.assignee_id = $${paramIndex})`;
         queryParams.push(userId);
         paramIndex++;

         // Фильтр по дате создания
         if (startDate) {
             try {
                 filters.startDate = new Date(startDate as string).toISOString();
                 queryParams.push(filters.startDate);
                 filters.startDateClause = `t.created_at >= $${paramIndex++}`;
             } catch (e) { res.status(400).json({ error: 'Неверный формат startDate (ожидается ISO 8601).' }); return; }
         }
         if (endDate) {
            try {
                filters.endDate = new Date(endDate as string).toISOString();
                queryParams.push(filters.endDate);
                filters.endDateClause = `t.created_at <= $${paramIndex++}`;
            } catch (e) { res.status(400).json({ error: 'Неверный формат endDate (ожидается ISO 8601).' }); return; }
         }

         // Фильтр по статусам
         if (status) {
              filters.status = (status as string).split(',').map(s => s.trim()).filter(s => s);
              if (filters.status.length > 0) {
                  queryParams.push(filters.status);
                  filters.statusClause = `t.status = ANY($${paramIndex++}::varchar[])`;
              }
         }
         // Фильтр по приоритетам
         if (priority) {
             try {
                filters.priority = (priority as string).split(',').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p));
                if (filters.priority.length > 0) {
                    queryParams.push(filters.priority);
                    filters.priorityClause = `t.priority = ANY($${paramIndex++}::integer[])`;
                }
            } catch(e) { /* Ignore parsing errors, effectively ignoring the filter */ }
         }

         // Фильтр по исполнителю
         let finalAssigneeId = assigneeId;
         if (assigneeId === 'me') {
             finalAssigneeId = userId;
         }
         if (finalAssigneeId) {
              filters.assigneeId = finalAssigneeId;
              queryParams.push(filters.assigneeId);
              // Обработка случая, когда ищем неназначенные задачи (assigneeId=null или 'null')
              if (String(finalAssigneeId).toLowerCase() === 'null') {
                 filters.assigneeIdClause = `t.assignee_id IS NULL`;
                 queryParams.pop(); // Убираем 'null' из параметров
              } else {
                 filters.assigneeIdClause = `t.assignee_id = $${paramIndex++}`;
              }
         }

         // Фильтр по создателю
         let finalCreatorId = creatorId;
         if (creatorId === 'me') {
             finalCreatorId = userId;
         }
         if (finalCreatorId) {
              filters.creatorId = finalCreatorId;
              queryParams.push(filters.creatorId);
              filters.creatorIdClause = `t.creator_id = $${paramIndex++}`;
         }

         // --- Новые фильтры --- 
         // Фильтр по сроку выполнения (due_date)
          if (dueDateStart) {
              try {
                  filters.dueDateStart = new Date(dueDateStart as string).toISOString();
                  queryParams.push(filters.dueDateStart);
                  filters.dueDateStartClause = `t.due_date >= $${paramIndex++}`;
              } catch (e) { res.status(400).json({ error: 'Неверный формат dueDateStart (ожидается ISO 8601).' }); return; }
          }
          if (dueDateEnd) {
              try {
                  filters.dueDateEnd = new Date(dueDateEnd as string).toISOString();
                  queryParams.push(filters.dueDateEnd);
                  filters.dueDateEndClause = `t.due_date <= $${paramIndex++}`;
              } catch (e) { res.status(400).json({ error: 'Неверный формат dueDateEnd (ожидается ISO 8601).' }); return; }
          }
          if (dueDateFilter === 'null') {
              filters.dueDateNullClause = `t.due_date IS NULL`;
          } else if (dueDateFilter === 'notnull') {
              filters.dueDateNotNullClause = `t.due_date IS NOT NULL`;
          }

          // Фильтр по "застрявшим" задачам (не обновлялись N дней)
          if (updatedBeforeDays) {
              try {
                  const days = parseInt(updatedBeforeDays as string, 10);
                  if (days > 0) {
                     filters.updatedBeforeDays = days;
                     // Вычисляем дату: NOW() - interval 'X days'
                     queryParams.push(`${days} days`); 
                     filters.updatedBeforeClause = `t.updated_at < (NOW() - $${paramIndex++}::interval)`;
                  } else {
                       console.warn('Некорректное значение для updatedBeforeDays (должно быть > 0), фильтр проигнорирован.');
                  }
              } catch (e) { 
                  console.warn('Некорректный формат updatedBeforeDays (ожидается число), фильтр проигнорирован.');
              }
          }

         // Собираем все WHERE условия
         const whereClauses = [
             accessClause, // Базовые права доступа
             filters.startDateClause,
             filters.endDateClause,
             filters.statusClause,
             filters.priorityClause,
             filters.assigneeIdClause,
             filters.creatorIdClause,
             // Новые:
             filters.dueDateStartClause,
             filters.dueDateEndClause,
             filters.dueDateNullClause,
             filters.dueDateNotNullClause,
             filters.updatedBeforeClause
         ].filter(Boolean); // Убираем пустые/null значения

         const whereCondition = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

         // ---- SQL запросы с агрегацией --- Вариант с несколькими запросами --- 
         const summaryQuery = `
             SELECT
                 COUNT(*) AS "totalTasks",
                 COUNT(*) FILTER (WHERE t.status NOT IN ('done', 'canceled') AND t.due_date < NOW()) AS "overdueTasks",
                 COUNT(*) FILTER (WHERE t.status = 'done') AS "completedTasks",
                 COUNT(*) FILTER (WHERE t.status = 'open') AS "openTasks",
                 COUNT(*) FILTER (WHERE t.status = 'in_progress') AS "inProgressTasks",
                 ${filters.updatedBeforeClause ? `COUNT(*) FILTER (WHERE ${filters.updatedBeforeClause.replace('t.updated_at < (NOW() - $'+(queryParams.findIndex((p, i) => typeof p === 'string' && p.endsWith(' days')) + 1)+'::interval)', 't.updated_at < (NOW() - $'+(queryParams.findIndex((p, i) => typeof p === 'string' && p.endsWith(' days')) + 1)+')')}) AS "staleTasks"` : '0 AS "staleTasks"'},
                 -- Новые счетчики характеристик
                 COUNT(DISTINCT t.id) FILTER (WHERE EXISTS (SELECT 1 FROM task_attachments ta WHERE ta.task_id = t.id)) AS "tasksWithAttachments",
                 COUNT(DISTINCT t.id) FILTER (WHERE EXISTS (SELECT 1 FROM task_comments tc WHERE tc.task_id = t.id)) AS "tasksWithComments"
             FROM tasks t
              ${whereCondition};
         `;

          const statusDistQuery = `
              SELECT t.status, COUNT(*) as count
              FROM tasks t
              ${whereCondition}
              GROUP BY t.status; 
          `;

          const priorityDistQuery = `
              SELECT 
                  t.priority, 
                  COUNT(*) as count,
                  -- Добавляем счетчик просроченных для каждого приоритета
                  COUNT(*) FILTER (WHERE t.status NOT IN ('done', 'canceled') AND t.due_date < NOW()) as "overdueCount"
              FROM tasks t
              ${whereCondition}
              GROUP BY t.priority;
          `;

           const assigneeDistQuery = `
               SELECT
                   t.assignee_id AS "assigneeId",
                   COALESCE(assignee.username, 'Не назначен') AS "assigneeUsername",
                   COUNT(*) as count,
                   COUNT(*) FILTER (WHERE t.status IN ('open', 'in_progress')) as "activeCount",
                   -- Добавляем завершенные и просроченные
                   COUNT(*) FILTER (WHERE t.status = 'done') as "completedCount",
                   COUNT(*) FILTER (WHERE t.status NOT IN ('done', 'canceled') AND t.due_date < NOW()) as "overdueCount"
               FROM tasks t
               LEFT JOIN users assignee ON t.assignee_id = assignee.id
               ${whereCondition}
               GROUP BY t.assignee_id, assignee.username
               ORDER BY count DESC NULLS LAST;
           `;

           const creatorDistQuery = `
                SELECT
                    t.creator_id AS "creatorId",
                    COALESCE(creator.username, 'Неизвестно') AS "creatorUsername",
                    COUNT(*) as count,
                    -- Добавляем завершенные и просроченные
                    COUNT(*) FILTER (WHERE t.status = 'done') as "completedCount",
                    COUNT(*) FILTER (WHERE t.status NOT IN ('done', 'canceled') AND t.due_date < NOW()) as "overdueCount"
                FROM tasks t
                LEFT JOIN users creator ON t.creator_id = creator.id
                ${whereCondition}
                GROUP BY t.creator_id, creator.username
                ORDER BY count DESC NULLS LAST;
            `;

          // Выполняем запросы параллельно
          const [
              summaryResult,
              statusDistResult,
              priorityDistResult,
              assigneeDistResult,
              creatorDistResult
          ] = await Promise.all([
              pool.query(summaryQuery, queryParams),
              pool.query(statusDistQuery, queryParams),
              pool.query(priorityDistQuery, queryParams),
              pool.query(assigneeDistQuery, queryParams),
              pool.query(creatorDistQuery, queryParams)
          ]);

          // Обрабатываем результаты
          const summaryStats = summaryResult.rows[0] || { totalTasks: 0, overdueTasks: 0, completedTasks: 0, openTasks: 0, inProgressTasks: 0, staleTasks: 0, tasksWithAttachments: 0, tasksWithComments: 0 }; // Добавлены новые поля
          // Преобразуем числа из строк в числа
          summaryStats.totalTasks = parseInt(summaryStats.totalTasks || '0', 10);
          summaryStats.overdueTasks = parseInt(summaryStats.overdueTasks || '0', 10);
          summaryStats.completedTasks = parseInt(summaryStats.completedTasks || '0', 10);
          summaryStats.openTasks = parseInt(summaryStats.openTasks || '0', 10);
          summaryStats.inProgressTasks = parseInt(summaryStats.inProgressTasks || '0', 10);
          summaryStats.staleTasks = parseInt(summaryStats.staleTasks || '0', 10);
          summaryStats.tasksWithAttachments = parseInt(summaryStats.tasksWithAttachments || '0', 10); // Новое поле
          summaryStats.tasksWithComments = parseInt(summaryStats.tasksWithComments || '0', 10); // Новое поле


          const distributionByStatus: { [key: string]: number } = {};
          statusDistResult.rows.forEach(row => {
              if(row.status) distributionByStatus[row.status] = parseInt(row.count, 10);
          });

          const distributionByPriority: Array<{ priority: number | null, count: number, overdueCount: number }> = []; // Обновлен тип
          priorityDistResult.rows.forEach(row => {
               if(row.priority !== null) { 
                  distributionByPriority.push({
                      priority: row.priority,
                      count: parseInt(row.count, 10),
                      overdueCount: parseInt(row.overdueCount || '0', 10) // Обработка overdueCount
                  });
              }
          });
          // Сортируем по приоритету для консистентности
          distributionByPriority.sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity)); 

          const distributionByAssignee: Array<{ 
              assigneeId: string | null, 
              assigneeUsername: string | null, 
              count: number, 
              activeCount: number, 
              completedCount: number, // Новое поле
              overduePercentage: number // Новое поле
            }> = assigneeDistResult.rows.map(row => {
                const count = parseInt(row.count, 10);
                const overdueCount = parseInt(row.overdueCount || '0', 10);
                const overduePercentage = count > 0 ? Math.round((overdueCount / count) * 100) : 0;
                return {
                   assigneeId: row.assigneeId,
                   assigneeUsername: row.assigneeUsername,
                   count: count,
                   activeCount: parseInt(row.activeCount || '0', 10),
                   completedCount: parseInt(row.completedCount || '0', 10), // Новое поле
                   overduePercentage: overduePercentage // Новое поле
               };
          });

           const distributionByCreator: Array<{ 
               creatorId: string | null, 
               creatorUsername: string | null, 
               count: number, 
               completedCount: number, // Новое поле
               overduePercentage: number // Новое поле
            }> = creatorDistResult.rows.map(row => {
                const count = parseInt(row.count, 10);
                const overdueCount = parseInt(row.overdueCount || '0', 10);
                const overduePercentage = count > 0 ? Math.round((overdueCount / count) * 100) : 0;
                return {
                   creatorId: row.creatorId,
                   creatorUsername: row.creatorUsername,
                   count: count,
                   completedCount: parseInt(row.completedCount || '0', 10), // Новое поле
                   overduePercentage: overduePercentage // Новое поле
               };
           });


         // 4. Собрать JSON ответ
         const report = {
             reportMetadata: {
                 generatedAt: new Date().toISOString(),
                 filtersApplied: {
                     startDate: startDate || null,
                     endDate: endDate || null,
                     status: status ? (status as string).split(',').map(s=>s.trim()) : null,
                     priority: priority ? (priority as string).split(',').map(p => parseInt(p.trim(), 10)).filter(p=>!isNaN(p)) : null,
                     assigneeId: assigneeId || null, // Отображаем исходный фильтр (может быть 'me' или 'null')
                     creatorId: creatorId || null,   // Отображаем исходный фильтр (может быть 'me')
                     // Новые фильтры:
                     dueDateStart: dueDateStart || null,
                     dueDateEnd: dueDateEnd || null,
                     dueDateFilter: dueDateFilter || null,
                     updatedBeforeDays: updatedBeforeDays ? parseInt(updatedBeforeDays as string, 10) : null
                 }
             },
             summaryStats,
             distribution: {
                 byStatus: distributionByStatus,
                 byPriority: distributionByPriority,
                 byAssignee: distributionByAssignee,
                 byCreator: distributionByCreator
             },
             // Оставляем timeMetrics как null, так как его реализация не требуется
             timeMetrics: null 
         };

         res.status(200).json(report);

    } catch (error: any) {
        console.error('Ошибка при генерации отчета по задачам:', error);
         // Обработка ошибок дат
         if (error.message.includes('invalid input syntax for type timestamp')) {
              res.status(400).json({ error: 'Неверный формат даты (ожидается ISO 8601).' });
         } else if (error.code === '22P02') { // Ошибка синтаксиса для числа/uuid
             res.status(400).json({ error: 'Неверный формат одного из фильтров (например, priority, assigneeId, creatorId).' });
         } else {
             res.status(500).json({ error: 'Не удалось сгенерировать отчет по задачам' });
         }
    }
};

