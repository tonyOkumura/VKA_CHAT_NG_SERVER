import { Request, Response } from 'express';
import pool from '../models/db';
import { PoolClient } from 'pg';
import path from 'path';
import fs from 'fs';
import * as socketService from '../services/socketService';

// Интерфейс для пользователя из req.user
interface AuthenticatedUser {
    id: string;
    username: string;
}

// Валидные статусы и приоритеты
const validStatuses = ['open', 'in_progress', 'done', 'canceled'];
const validPriorities = [1, 2, 3, 4, 5];

// Helper function to get user details with avatar
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
            avatarPath: relativePath
        };
    } catch (error) {
        console.error(`Error fetching username/avatar for user ${userId}:`, error);
        return { id: userId, username: null, avatarPath: null };
    }
};

// Создание новой задачи
export const createTask = async (req: Request, res: Response): Promise<void> => {
    const { title, description, status, priority, assignee_id, due_date } = req.body;
    const creator_id = (req.user as AuthenticatedUser)?.id;

    if (!title || !creator_id) {
        res.status(400).json({ error: 'Необходимо указать название задачи.' });
        return;
    }
    if (status && !validStatuses.includes(status)) {
        res.status(400).json({ error: `Статус должен быть одним из: ${validStatuses.join(', ')}.` });
        return;
    }
    if (priority && !validPriorities.includes(priority)) {
        res.status(400).json({ error: 'Приоритет должен быть от 1 до 5.' });
        return;
    }

    try {
        const result = await pool.query(
            `INSERT INTO tasks (title, description, status, priority, creator_id, assignee_id, due_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [title, description, status || 'open', priority || 3, creator_id, assignee_id, due_date]
        );

        const newTask = result.rows[0];
        const creatorDetails = await getUserDetailsWithAvatar(newTask.creator_id);
        const assigneeDetails = await getUserDetailsWithAvatar(newTask.assignee_id);

        const eventPayload = {
            ...newTask,
            creator_username: creatorDetails.username,
            assignee_username: assigneeDetails.username,
            creatorAvatarPath: creatorDetails.avatarPath,
            assigneeAvatarPath: assigneeDetails.avatarPath,
            due_date: newTask.due_date ? new Date(newTask.due_date).toISOString() : null,
            created_at: new Date(newTask.created_at).toISOString(),
            updated_at: new Date(newTask.updated_at).toISOString(),
        };
        socketService.emitToRoom('general_tasks', 'newTaskCreated', eventPayload);

        res.status(201).json(eventPayload);
        console.log(`Задача "${title}" (ID: ${newTask.id}) создана пользователем ${creator_id}`);
    } catch (error: any) {
        console.error('Ошибка при создании задачи:', error);
        res.status(500).json({ error: 'Не удалось создать задачу' });
    }
};

// Получение списка задач
export const getTasks = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id;
    const { status, search, page = '1', limit = '10' } = req.query;

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    if (isNaN(pageNum) || isNaN(limitNum) || pageNum < 1 || limitNum < 1) {
        res.status(400).json({ error: 'Неверные параметры пагинации.' });
        return;
    }
    const offset = (pageNum - 1) * limitNum;

    try {
        let queryText = `
            SELECT t.*, 
                   creator.username AS creator_username, 
                   assignee.username AS assignee_username,
                   creator_avatar.file_path AS "creatorAvatarPath",
                   assignee_avatar.file_path AS "assigneeAvatarPath"
            FROM tasks t
            LEFT JOIN users creator ON t.creator_id = creator.id
            LEFT JOIN users assignee ON t.assignee_id = assignee.id
            LEFT JOIN user_avatars creator_avatar ON t.creator_id = creator_avatar.user_id
            LEFT JOIN user_avatars assignee_avatar ON t.assignee_id = assignee_avatar.user_id
            WHERE (t.creator_id = $1 OR t.assignee_id = $1)
        `;
        const queryParams: any[] = [userId];
        let paramIndex = 2;

        if (status) {
            if (!validStatuses.includes(status as string)) {
                res.status(400).json({ error: `Статус должен быть одним из: ${validStatuses.join(', ')}.` });
                return;
            }
            queryText += ` AND t.status = $${paramIndex++}`;
            queryParams.push(status);
        }

        if (search) {
            queryText += ` AND (t.title ILIKE $${paramIndex} OR t.description ILIKE $${paramIndex})`;
            queryParams.push(`%${search}%`);
            paramIndex++;
        }

        queryText += ` ORDER BY t.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
        queryParams.push(limitNum, offset);

        const result = await pool.query(queryText, queryParams);

        const tasks = result.rows.map(task => ({
            ...task,
            due_date: task.due_date ? new Date(task.due_date).toISOString() : null,
            created_at: new Date(task.created_at).toISOString(),
            updated_at: new Date(task.updated_at).toISOString(),
        }));

        res.status(200).json(tasks);
        console.log(`Получен список задач для пользователя ${userId} с фильтрами: status=${status}, search=${search}, page=${page}, limit=${limit}`);
    } catch (error: any) {
        console.error('Ошибка при получении списка задач:', error);
        res.status(500).json({ error: 'Не удалось получить список задач' });
    }
};

// Получение задачи по ID
export const getTaskById = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id;
    const { taskId } = req.params;

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }

    try {
        const queryText = `
            SELECT t.*, 
                   creator.username AS creator_username, 
                   assignee.username AS assignee_username,
                   creator_avatar.file_path AS "creatorAvatarPath",
                   assignee_avatar.file_path AS "assigneeAvatarPath"
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

        const responseTask = {
            ...task,
            due_date: task.due_date ? new Date(task.due_date).toISOString() : null,
            created_at: new Date(task.created_at).toISOString(),
            updated_at: new Date(task.updated_at).toISOString(),
        };

        res.status(200).json(responseTask);
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

// Обновление задачи
export const updateTask = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id;
    const { taskId } = req.params;
    const updates = req.body;

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }

    if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'Нет данных для обновления.' });
        return;
    }

    const allowedUpdates = ['title', 'description', 'status', 'priority', 'assignee_id', 'due_date'];
    const updatesToApply: { [key: string]: any } = {};
    const logEntriesData: Array<{ action: string, old_value: string, new_value: string }> = [];

    if (updates.status && !validStatuses.includes(updates.status)) {
        res.status(400).json({ error: `Статус должен быть одним из: ${validStatuses.join(', ')}.` });
        return;
    }
    if (updates.priority && !validPriorities.includes(updates.priority)) {
        res.status(400).json({ error: 'Приоритет должен быть от 1 до 5.' });
        return;
    }

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

        if (currentTask.creator_id !== userId && currentTask.assignee_id !== userId) {
            await client.query('ROLLBACK');
            res.status(403).json({ error: 'Вы не можете обновлять эту задачу.' });
            return;
        }

        const updateQueryParams = [taskId];
        let placeholderIndex = 2;
        const updateSetClauses: string[] = [];

        Object.keys(updatesToApply).forEach(key => {
            const oldValue = currentTask[key];
            const newValue = updatesToApply[key];
            const oldValueStr = oldValue instanceof Date ? oldValue.toISOString() : String(oldValue);
            const newValueStr = newValue instanceof Date ? newValue.toISOString() : String(newValue);

            if (oldValueStr !== newValueStr) {
                updateQueryParams.push(newValue);
                updateSetClauses.push(`${key} = $${placeholderIndex}`);
                placeholderIndex++;

                let actionText = `Изменено поле ${key}`;
                if (key === 'assignee_id') actionText = 'Изменен исполнитель';
                if (key === 'status') actionText = 'Изменен статус';
                if (key === 'priority') actionText = 'Изменен приоритет';
                if (key === 'due_date') actionText = 'Изменен срок выполнения';

                logEntriesData.push({
                    action: actionText,
                    old_value: oldValueStr,
                    new_value: newValueStr ?? 'null'
                });
            }
        });

        if (updateSetClauses.length === 0) {
            await client.query('ROLLBACK');
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
            };
            res.status(200).json({ message: 'Нет изменений для применения.', task: noChangeResponse });
            console.log(`Task ${taskId} update requested by ${userId}, but no actual changes detected.`);
            client.release();
            return;
        }

        updateSetClauses.push(`updated_at = CURRENT_TIMESTAMP`);
        const updateQuery = `UPDATE tasks SET ${updateSetClauses.join(', ')} WHERE id = $1 RETURNING *`;

        const updatedResult = await client.query(updateQuery, updateQueryParams);
        const updatedTask = updatedResult.rows[0];

        if (logEntriesData.length > 0) {
            const logValues = logEntriesData.map(log =>
                `($1, '${log.action.replace(/'/g, "''")}', '${String(log.old_value).replace(/'/g, "''")}', '${String(log.new_value).replace(/'/g, "''")}', $2)`
            ).join(',');
            const logQuery = `INSERT INTO task_logs (task_id, action, old_value, new_value, changed_by) VALUES ${logValues}`;
            await client.query(logQuery, [taskId, userId]);
        }

        await client.query('COMMIT');

        const creatorDetails = await getUserDetailsWithAvatar(updatedTask.creator_id, client);
        const assigneeDetails = await getUserDetailsWithAvatar(updatedTask.assignee_id, client);
        const changerDetails = await getUserDetailsWithAvatar(userId, client);

        const eventPayload = {
            ...updatedTask,
            creator_username: creatorDetails.username,
            assignee_username: assigneeDetails.username,
            creatorAvatarPath: creatorDetails.avatarPath,
            assigneeAvatarPath: assigneeDetails.avatarPath,
            change_details: logEntriesData,
            changed_by: {
                user_id: changerDetails.id,
                username: changerDetails.username,
                avatarPath: changerDetails.avatarPath
            },
            due_date: updatedTask.due_date ? new Date(updatedTask.due_date).toISOString() : null,
            created_at: new Date(updatedTask.created_at).toISOString(),
            updated_at: new Date(updatedTask.updated_at).toISOString(),
        };

        const taskRoom = `task_${taskId}`;
        socketService.emitToRoom(taskRoom, 'taskUpdated', eventPayload);
        socketService.emitToRoom('general_tasks', 'taskUpdated', eventPayload);

        const responseTask = {
            ...updatedTask,
            creator_username: creatorDetails.username,
            assignee_username: assigneeDetails.username,
            creatorAvatarPath: creatorDetails.avatarPath,
            assigneeAvatarPath: assigneeDetails.avatarPath,
            due_date: updatedTask.due_date ? new Date(updatedTask.due_date).toISOString() : null,
            created_at: new Date(updatedTask.created_at).toISOString(),
            updated_at: new Date(updatedTask.updated_at).toISOString(),
        };

        res.status(200).json(responseTask);
        console.log(`Задача ID: ${taskId} успешно обновлена пользователем ${userId}`);
    } catch (error: any) {
        if (client) {
            await client.query('ROLLBACK');
        }
        console.error(`Ошибка при обновлении задачи ID ${taskId}:`, error);
        if (error.code === '22P02') {
            res.status(400).json({ error: 'Неверный формат ID задачи или исполнителя.' });
        } else if (error.code === '23503') {
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

// Удаление задачи
export const deleteTask = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id;
    const { taskId } = req.params;

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }

    let client: PoolClient | null = null;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const taskResult = await client.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);

        if (taskResult.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка удалить несуществующую задачу ID: ${taskId} пользователем ${userId}`);
            client.release();
            return;
        }

        const task = taskResult.rows[0];
        if (task.creator_id !== userId && task.assignee_id !== userId) {
            await client.query('ROLLBACK');
            res.status(403).json({ error: 'У вас нет прав на удаление этой задачи.' });
            console.log(`Пользователь ${userId} пытался удалить задачу ${taskId}, созданную ${task.creator_id}.`);
            client.release();
            return;
        }

        const attachmentsResult = await client.query('SELECT file_path FROM task_attachments WHERE task_id = $1', [taskId]);
        const filePathsToDelete = attachmentsResult.rows.map(row => row.file_path);

        const deleteResult = await client.query('DELETE FROM tasks WHERE id = $1 RETURNING id', [taskId]);

        if (deleteResult.rowCount === 0) {
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Не удалось найти задачу для удаления после проверки.' });
            console.error(`Не удалось найти задачу ${taskId} для удаления после проверки.`);
            client.release();
            return;
        }

        for (const filePath of filePathsToDelete) {
            const fullPath = path.resolve(filePath);
            try {
                if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                    console.log(`Файл вложения удален с диска: ${fullPath}`);
                }
            } catch (fsError) {
                console.error(`Ошибка при удалении файла вложения ${fullPath} с диска:`, fsError);
            }
        }

        await client.query('COMMIT');

        const eventPayloadDelete = { taskId: taskId };
        const taskRoomDelete = `task_${taskId}`;
        socketService.emitToRoom(taskRoomDelete, 'taskDeleted', eventPayloadDelete);
        socketService.emitToRoom('general_tasks', 'taskDeleted', eventPayloadDelete);

        res.status(200).json({ message: 'Задача и все связанные данные успешно удалены.', taskId: taskId });
        console.log(`Задача ID: ${taskId} успешно удалена пользователем ${userId}.`);
    } catch (error: any) {
        if (client) {
            await client.query('ROLLBACK');
            console.error(`Транзакция удаления задачи ${taskId} отменена из-за ошибки.`);
        }
        console.error(`Ошибка при удалении задачи ID ${taskId}:`, error);
        if (error.code === '22P02') {
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

// Добавление комментария
export const addTaskComment = async (req: Request, res: Response): Promise<void> => {
    const commenter_id = (req.user as AuthenticatedUser)?.id;
    const { taskId } = req.params;
    const { comment } = req.body;

    if (!commenter_id) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }
    if (!taskId || !comment) {
        res.status(400).json({ error: 'Не указан ID задачи или текст комментария.' });
        return;
    }

    try {
        const taskCheck = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskCheck.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            return;
        }
        const taskData = taskCheck.rows[0];
        if (taskData.creator_id !== commenter_id && taskData.assignee_id !== commenter_id) {
            res.status(403).json({ error: 'Вы не можете комментировать эту задачу.' });
            return;
        }

        const result = await pool.query(
            'INSERT INTO task_comments (task_id, commenter_id, comment) VALUES ($1, $2, $3) RETURNING *',
            [taskId, commenter_id, comment]
        );
        const newComment = result.rows[0];

        const commenterDetails = await getUserDetailsWithAvatar(newComment.commenter_id);
        const eventPayload = {
            ...newComment,
            commenter_username: commenterDetails.username,
            commenterAvatarPath: commenterDetails.avatarPath,
            created_at: new Date(newComment.created_at).toISOString()
        };
        const taskRoom = `task_${taskId}`;
        socketService.emitToRoom(taskRoom, 'newTaskComment', eventPayload);

        res.status(201).json(eventPayload);
        console.log(`Комментарий к задаче ${taskId} добавлен пользователем ${commenter_id}`);
    } catch (error: any) {
        console.error(`Ошибка при добавлении комментария к задаче ${taskId}:`, error);
        if (error.code === '23503') {
            res.status(404).json({ error: 'Задача или пользователь не найдены.' });
        } else if (error.code === '22P02') {
            res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось добавить комментарий' });
        }
    }
};

// Получение комментариев
export const getTaskComments = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id;
    const { taskId } = req.params;

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }
    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }

    try {
        const taskCheck = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskCheck.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            return;
        }
        const taskData = taskCheck.rows[0];
        if (taskData.creator_id !== userId && taskData.assignee_id !== userId) {
            res.status(403).json({ error: 'Вы не можете просматривать комментарии к этой задаче.' });
            return;
        }

        const result = await pool.query(
            `
            SELECT tc.*, 
                   u.username AS commenter_username,
                   ua.file_path AS "commenterAvatarPath"
            FROM task_comments tc
            LEFT JOIN users u ON tc.commenter_id = u.id
            LEFT JOIN user_avatars ua ON tc.commenter_id = ua.user_id
            WHERE tc.task_id = $1 
            ORDER BY tc.created_at ASC
            `,
            [taskId]
        );

        const comments = result.rows.map(comment => ({
            ...comment,
            created_at: new Date(comment.created_at).toISOString(),
        }));

        res.status(200).json(comments);
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

// Добавление вложения
export const addTaskAttachment = async (req: Request, res: Response): Promise<void> => {
    const uploader_id = (req.user as AuthenticatedUser)?.id;
    const { taskId } = req.params;
    const file = req.file;

    if (!uploader_id) {
        if (file) fs.unlinkSync(file.path);
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId) {
        if (file) fs.unlinkSync(file.path);
        res.status(400).json({ error: 'Не указан ID задачи.' });
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

        const taskResult = await client.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskResult.rows.length === 0) {
            await client.query('ROLLBACK');
            fs.unlinkSync(file.path);
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка добавить вложение к несуществующей задаче ID: ${taskId} пользователем ${uploader_id}`);
            client.release();
            return;
        }
        const task = taskResult.rows[0];
        if (task.creator_id !== uploader_id && task.assignee_id !== uploader_id) {
            await client.query('ROLLBACK');
            fs.unlinkSync(file.path);
            res.status(403).json({ error: 'У вас нет прав добавлять вложения к этой задаче.' });
            console.log(`Пользователь ${uploader_id} пытался добавить вложение к задаче ${taskId}, к которой не имеет отношения.`);
            client.release();
            return;
        }

        const { originalname, path: filePath, mimetype, size } = file;
        if (size > 10 * 1024 * 1024) { // 10 MB limit
            await client.query('ROLLBACK');
            fs.unlinkSync(filePath);
            res.status(400).json({ error: 'Размер файла превышает 10 МБ.' });
            return;
        }

        const insertResult = await client.query(
            `INSERT INTO task_attachments (task_id, file_name, file_path, file_type, file_size, uploader_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [taskId, originalname, filePath, mimetype, size, uploader_id]
        );
        const newAttachment = insertResult.rows[0];

        await client.query('COMMIT');

        const uploaderDetails = await getUserDetailsWithAvatar(newAttachment.uploader_id);
        const eventPayload = {
            id: newAttachment.id,
            task_id: newAttachment.task_id,
            file_name: newAttachment.file_name,
            file_type: newAttachment.file_type,
            file_size_bytes: newAttachment.file_size,
            uploaded_at: new Date(newAttachment.created_at).toISOString(),
            uploaded_by_id: newAttachment.uploader_id,
            uploaded_by_username: uploaderDetails.username,
        };
        const attachmentTargetRoom = `task_${taskId}`;
        socketService.emitToRoom(attachmentTargetRoom, 'newTaskAttachment', eventPayload);

        res.status(201).json(eventPayload);
        console.log(`Вложение ID ${newAttachment.id} добавлено к задаче ${taskId} пользователем ${uploader_id}.`);
    } catch (error: any) {
        if (client) {
            await client.query('ROLLBACK');
            console.error(`Транзакция добавления вложения к задаче ${taskId} отменена из-за ошибки.`);
        }
        if (file) fs.unlinkSync(file.path);
        console.error(`Ошибка при добавлении вложения к задаче ${taskId}:`, error);
        if (error.code === '22P02') {
            res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else if (error.code === '23503') {
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

// Получение вложений
export const getTaskAttachments = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id;
    const { taskId } = req.params;

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }

    console.log('get taskAtaments ')

    try {
        const taskResult = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskResult.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка получить вложения несуществующей задачи ID: ${taskId} пользователем ${userId}`);
            return;
        }
        const task = taskResult.rows[0];
        if (task.creator_id !== userId && task.assignee_id !== userId) {
            res.status(403).json({ error: 'У вас нет прав на просмотр вложений этой задачи.' });
            console.log(`Пользователь ${userId} пытался получить вложения задачи ${taskId}, к которой не имеет отношения.`);
            return;
        }

        const result = await pool.query(
            `
            SELECT ta.*, 
                   u.username AS uploaded_by_username
            FROM task_attachments ta
            LEFT JOIN users u ON ta.uploader_id = u.id
            WHERE ta.task_id = $1
            ORDER BY ta.created_at ASC
            `,
            [taskId]
        );

        const attachments = result.rows.map(attachment => ({
            id: attachment.id,
            task_id: attachment.task_id,
            file_name: attachment.file_name,
            file_type: attachment.file_type,
            file_size_bytes: attachment.file_size,
            uploaded_at: new Date(attachment.created_at).toISOString(),
            uploaded_by_id: attachment.uploader_id,
            uploaded_by_username: attachment.uploaded_by_username,
        }));

        res.status(200).json(attachments);
        console.log(`Получены вложения для задачи ${taskId} пользователем ${userId}`);
    } catch (error: any) {
        console.error(`Ошибка при получении вложений задачи ${taskId}:`, error);
        if (error.code === '22P02') {
            res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось получить вложения' });
        }
    }
};

// Удаление вложения
export const deleteTaskAttachment = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id;
    const { taskId, attachmentId } = req.body;

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId || !attachmentId) {
        res.status(400).json({ error: 'Не указан ID задачи или вложения в теле запроса.' });
        return;
    }

    let client: PoolClient | null = null;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const taskResult = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskResult.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка удалить вложение из несуществующей задачи ID: ${taskId} пользователем ${userId}`);
            client.release();
            return;
        }
        const task = taskResult.rows[0];
        if (task.creator_id !== userId && task.assignee_id !== userId) {
            await client.query('ROLLBACK');
            res.status(403).json({ error: 'У вас нет прав на удаление вложений этой задачи.' });
            console.log(`Пользователь ${userId} пытался удалить вложение ${attachmentId} из задачи ${taskId}, к которой не имеет отношения.`);
            client.release();
            return;
        }

        const attachmentResult = await pool.query(
            'SELECT file_path FROM task_attachments WHERE id = $1 AND task_id = $2',
            [attachmentId, taskId]
        );
        if (attachmentResult.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Вложение не найдено.' });
            console.log(`Попытка удалить несуществующее вложение ID: ${attachmentId} для задачи ${taskId}`);
            client.release();
            return;
        }

        const filePath = attachmentResult.rows[0].file_path;
        const deleteResult = await client.query(
            'DELETE FROM task_attachments WHERE id = $1 AND task_id = $2 RETURNING id',
            [attachmentId, taskId]
        );

        if (deleteResult.rowCount === 0) {
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Не удалось удалить вложение.' });
            console.log(`Не удалось удалить вложение ID: ${attachmentId} для задачи ${taskId}`);
            client.release();
            return;
        }

        const fullPath = path.resolve(filePath);
        try {
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
                console.log(`Файл вложения удален с диска: ${fullPath}`);
            }
        } catch (fsError) {
            console.error(`Ошибка при удалении файла вложения ${fullPath} с диска:`, fsError);
        }

        await client.query('COMMIT');

        const eventPayload = { taskId, attachmentId };
        const taskRoom = `task_${taskId}`;
        socketService.emitToRoom(taskRoom, 'taskAttachmentDeleted', eventPayload);

        res.status(200).json({ message: 'Вложение успешно удалено.', attachmentId });
        console.log(`Вложение ID ${attachmentId} удалено из задачи ${taskId} пользователем ${userId}`);
    } catch (error: any) {
        if (client) {
            await client.query('ROLLBACK');
            console.error(`Транзакция удаления вложения ${attachmentId} отменена из-за ошибки.`);
        }
        console.error(`Ошибка при удалении вложения ${attachmentId} задачи ${taskId}:`, error);
        if (error.code === '22P02') {
            res.status(400).json({ error: 'Неверный формат ID задачи или вложения.' });
        } else {
            res.status(500).json({ error: 'Не удалось удалить вложение' });
        }
    } finally {
        if (client) {
            client.release();
            console.log(`Клиент базы данных освобожден после удаления вложения ${attachmentId}.`);
        }
    }
};
// Скачивание вложения
export const downloadTaskAttachment = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id;
    const { taskId, attachmentId } = req.body;

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId || !attachmentId) {
        res.status(400).json({ error: 'Не указан ID задачи или вложения в теле запроса.' });
        return;
    }

    try {
        const fileResult = await pool.query(
            `SELECT ta.file_path, ta.file_name, t.creator_id, t.assignee_id
             FROM task_attachments ta
             JOIN tasks t ON ta.task_id = t.id
             WHERE ta.id = $1 AND ta.task_id = $2`,
            [attachmentId, taskId]
        );

        if (fileResult.rows.length === 0) {
            res.status(404).json({ error: 'Вложение не найдено.' });
            console.log(`Попытка скачать несуществующее вложение ID: ${attachmentId} для задачи ${taskId}`);
            return;
        }

        const { file_path, file_name, creator_id, assignee_id } = fileResult.rows[0];

        if (creator_id !== userId && assignee_id !== userId) {
            res.status(403).json({ error: 'У вас нет прав на скачивание этого вложения.' });
            console.log(`Пользователь ${userId} пытался скачать вложение ${attachmentId} из задачи ${taskId}, к которой не имеет отношения.`);
            return;
        }

        const fullPath = path.resolve(file_path);
        if (!fs.existsSync(fullPath)) {
            res.status(404).json({ error: 'Файл вложения не найден на сервере.' });
            console.log(`Файл вложения ${fullPath} не найден на диске для скачивания.`);
            return;
        }

        res.download(fullPath, file_name, err => {
            if (err) {
                console.error(`Ошибка при скачивании вложения ${attachmentId}:`, err);
                res.status(500).json({ error: 'Ошибка при скачивании файла.' });
            } else {
                console.log(`Вложение ID ${attachmentId} скачано пользователем ${userId} из задачи ${taskId}`);
            }
        });
    } catch (error: any) {
        console.error(`Ошибка при скачивании вложения ${attachmentId} задачи ${taskId}:`, error);
        if (error.code === '22P02') {
            res.status(400).json({ error: 'Неверный формат ID задачи или вложения.' });
        } else {
            res.status(500).json({ error: 'Не удалось скачать вложение' });
        }
    }
};

// Получение логов изменений
export const getTaskLogs = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id;
    const { taskId } = req.params;

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }

    try {
        const taskCheck = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskCheck.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка получить логи несуществующей задачи ID: ${taskId} пользователем ${userId}`);
            return;
        }
        const taskData = taskCheck.rows[0];
        if (taskData.creator_id !== userId && taskData.assignee_id !== userId) {
            res.status(403).json({ error: 'Вы не можете просматривать логи этой задачи.' });
            console.log(`Пользователь ${userId} пытался получить логи задачи ${taskId}, к которой не имеет отношения.`);
            return;
        }

        const result = await pool.query(
            `
            SELECT tl.*, u.username
            FROM task_logs tl
            LEFT JOIN users u ON tl.changed_by = u.id
            WHERE tl.task_id = $1
            ORDER BY tl.created_at ASC
            `,
            [taskId]
        );

        const logs = result.rows.map(log => ({
            logId: log.id,
            task_id: log.task_id,
            action: log.action,
            old_value: log.old_value,
            new_value: log.new_value,
            user_id: log.changed_by,
            username: log.username,
            timestamp: new Date(log.created_at).toISOString(),
        }));

        res.status(200).json(logs);
        console.log(`Получены логи для задачи ${taskId} пользователем ${userId}`);
    } catch (error: any) {
        console.error(`Ошибка при получении логов задачи ${taskId}:`, error);
        if (error.code === '22P02') {
            res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось получить логи' });
        }
    }
};

// Генерация отчета
export const generateTaskReport = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id;
    const { status, startDate, endDate } = req.query;

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
        let paramIndex = 2;

        if (status) {
            if (!validStatuses.includes(status as string)) {
                res.status(400).json({ error: `Статус должен быть одним из: ${validStatuses.join(', ')}.` });
                return;
            }
            queryText += ` AND t.status = $${paramIndex++}`;
            queryParams.push(status);
        }

        if (startDate) {
            queryText += ` AND t.created_at >= $${paramIndex++}`;
            queryParams.push(startDate);
        }

        if (endDate) {
            queryText += ` AND t.created_at <= $${paramIndex++}`;
            queryParams.push(endDate);
        }

        queryText += ` ORDER BY t.created_at DESC`;

        const result = await pool.query(queryText, queryParams);

        const tasks = result.rows.map(task => ({
            id: task.id,
            title: task.title,
            description: task.description,
            status: task.status,
            priority: task.priority,
            creator_id: task.creator_id,
            creator_username: task.creator_username,
            assignee_id: task.assignee_id,
            assignee_username: task.assignee_username,
            due_date: task.due_date ? new Date(task.due_date).toISOString() : null,
            created_at: new Date(task.created_at).toISOString(),
            updated_at: new Date(task.updated_at).toISOString(),
        }));

        const report = {
            totalTasks: tasks.length,
            tasksByStatus: validStatuses.reduce((acc, stat) => {
                acc[stat] = tasks.filter(task => task.status === stat).length;
                return acc;
            }, {} as Record<string, number>),
            tasks: tasks,
            generatedAt: new Date().toISOString(),
        };

        res.status(200).json(report);
        console.log(`Отчет по задачам сгенерирован для пользователя ${userId}`);
    } catch (error: any) {
        console.error('Ошибка при генерации отчета:', error);
        res.status(500).json({ error: 'Не удалось сгенерировать отчет' });
    }
};

// Получение информации о конкретном вложении
export const getTaskAttachmentInfo = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.user as AuthenticatedUser)?.id;
    const { taskId, attachmentId } = req.body;

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId || !attachmentId) {
        res.status(400).json({ error: 'Не указан ID задачи или вложения в теле запроса.' });
        return;
    }

    try {
        // Проверяем, что пользователь имеет доступ к задаче
        const taskResult = await pool.query(
            'SELECT creator_id, assignee_id FROM tasks WHERE id = $1',
            [taskId]
        );
        if (taskResult.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка получить информацию о вложении для несуществующей задачи ID: ${taskId} пользователем ${userId}`);
            return;
        }
        const task = taskResult.rows[0];
        if (task.creator_id !== userId && task.assignee_id !== userId) {
            res.status(403).json({ error: 'У вас нет прав на просмотр этого вложения.' });
            console.log(`Пользователь ${userId} пытался получить информацию о вложении ${attachmentId} задачи ${taskId}, к которой не имеет отношения.`);
            return;
        }

        // Запрашиваем информацию о вложении
        const attachmentResult = await pool.query(
            `
            SELECT ta.id, ta.file_name, ta.file_type, ta.file_size, ta.created_at
            FROM task_attachments ta
            WHERE ta.id = $1 AND ta.task_id = $2
            `,
            [attachmentId, taskId]
        );

        if (attachmentResult.rows.length === 0) {
            res.status(404).json({ error: 'Вложение не найдено.' });
            console.log(`Попытка получить информацию о несуществующем вложении ID: ${attachmentId} для задачи ${taskId}`);
            return;
        }

        const attachment = attachmentResult.rows[0];
        const response = {
            id: attachment.id,
            file_name: attachment.file_name,
            file_type: attachment.file_type,
            file_size: attachment.file_size,
            created_at: new Date(attachment.created_at).toISOString(),
            download_url: `/api/tasks/attachments/download` // Указываем маршрут для скачивания
        };

        res.status(200).json(response);
        console.log(`Информация о вложении ID ${attachmentId} для задачи ${taskId} получена пользователем ${userId}`);
    } catch (error: any) {
        console.error(`Ошибка при получении информации о вложении ${attachmentId} задачи ${taskId}:`, error);
        if (error.code === '22P02') {
            res.status(400).json({ error: 'Неверный формат ID задачи или вложения.' });
        } else {
            res.status(500).json({ error: 'Не удалось получить информацию о вложении' });
        }
    }
};