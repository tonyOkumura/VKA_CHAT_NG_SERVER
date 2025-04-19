import { Request, Response } from 'express';
import pool from '../models/db';
import { PoolClient } from 'pg'; // Импортируем PoolClient для транзакций
import path from 'path'; // Добавляем импорт path
import fs from 'fs'; // Добавляем импорт fs
// import { io } from '../index'; // Убираем прямой импорт io
import * as socketService from '../services/socketService'; // Импортируем сервис

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

        // Fetch usernames for the event payload
        const creatorDetails = await getUserDetails(newTask.creator_id);
        const assigneeDetails = await getUserDetails(newTask.assignee_id);

        // Emit event to general tasks room
        const eventPayload = {
            ...newTask,
            creator_username: creatorDetails.username,
            assignee_username: assigneeDetails.username,
            // Ensure dates are in ISO 8601 format (Postgres typically returns them this way)
            due_date: newTask.due_date ? new Date(newTask.due_date).toISOString() : null,
            created_at: new Date(newTask.created_at).toISOString(),
            updated_at: new Date(newTask.updated_at).toISOString(),
        };
        // console.log(`[Socket Emit] Event: newTaskCreated | Target: Room general_tasks`); // Лог внутри сервиса
        // io.to('general_tasks').emit('newTaskCreated', eventPayload);
        socketService.emitToRoom('general_tasks', 'newTaskCreated', eventPayload);
        // console.log(`Event newTaskCreated emitted for task ${newTask.id}`);

        res.status(201).json(newTask); // Send back the raw task data as before
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

        // Ensure dates are in ISO 8601 format for consistency if needed by frontend
        const tasksWithIsoDates = result.rows.map(task => ({
            ...task,
            due_date: task.due_date ? new Date(task.due_date).toISOString() : null,
            created_at: new Date(task.created_at).toISOString(),
            updated_at: new Date(task.updated_at).toISOString(),
        }));

        res.status(200).json(tasksWithIsoDates);
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

         // Ensure dates are in ISO 8601 format
        const taskWithIsoDates = {
            ...task,
            due_date: task.due_date ? new Date(task.due_date).toISOString() : null,
            created_at: new Date(task.created_at).toISOString(),
            updated_at: new Date(task.updated_at).toISOString(),
        };

        res.status(200).json(taskWithIsoDates);
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
    const userId = req.user?.id;
    const { id: taskId } = req.params; // Rename id to taskId for clarity
    const updates = req.body;

    console.log(`Попытка обновления задачи ID: ${taskId} пользователем ${userId}. Данные:`, updates);

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

        const currentTaskResult = await client.query('SELECT * FROM tasks WHERE id = $1', [taskId]);

        if (currentTaskResult.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка обновить несуществующую задачу ID: ${taskId} пользователем ${userId}`);
            client.release(); // Release client on error
            return;
        }

        const currentTask = currentTaskResult.rows[0];

        // if (currentTask.creator_id !== userId && currentTask.assignee_id !== userId) {
        //     await client.query('ROLLBACK');
        //     res.status(403).json({ error: 'У вас нет прав на обновление этой задачи.' });
        //     console.log(`Пользователь ${userId} пытался обновить задачу ${taskId}, к которой не имеет отношения.`);
        //     client.release(); // Release client on error
        // }

        const setClauses: string[] = [];
        const queryParams: any[] = [];
        let paramIndex = 1;

        Object.keys(updatesToApply).forEach(key => {
            const oldValue = currentTask[key];
            const newValue = updatesToApply[key];
            if (String(oldValue ?? '') !== String(newValue ?? '')) {
                // Handle potential empty string vs null difference for assignee_id
                if (key === 'assignee_id' && !newValue) {
                    setClauses.push(`${key} = $${paramIndex++}`);
                    queryParams.push(null); // Ensure empty assignee becomes NULL
                } else {
                setClauses.push(`${key} = $${paramIndex++}`);
                queryParams.push(newValue);
                }

                logEntriesData.push({
                    action: `update_${key}`,
                    old_value: String(oldValue ?? 'null'),
                    new_value: String(newValue ?? 'null'),
                });
            }
        });

        if (setClauses.length === 0) {
             await client.query('ROLLBACK');
            // Fetch potentially updated usernames for the response
            const creatorDetails = await getUserDetails(currentTask.creator_id, client);
            const assigneeDetails = await getUserDetails(currentTask.assignee_id, client);
            const taskWithUsernames = {
                 ...currentTask,
                 creator_username: creatorDetails.username,
                 assignee_username: assigneeDetails.username,
                 due_date: currentTask.due_date ? new Date(currentTask.due_date).toISOString() : null,
                 created_at: new Date(currentTask.created_at).toISOString(),
                 updated_at: new Date(currentTask.updated_at).toISOString(),
            }
             res.status(200).json(taskWithUsernames);
             console.log(`Попытка обновить задачу ID: ${taskId} пользователем ${userId}, но значения не изменились.`);
             client.release(); // Release client
             return;
        }

        // Add updated_at clause
        setClauses.push(`updated_at = CURRENT_TIMESTAMP`);

        const updateQuery = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
        queryParams.push(taskId);

        const updatedTaskResult = await client.query(updateQuery, queryParams);
        const updatedTask = updatedTaskResult.rows[0];

        // 3. Вставляем записи в лог
        if (logEntriesData.length > 0) {
            const logPromises = logEntriesData.map(log => {
                return client!.query(
                    `INSERT INTO task_logs (task_id, action, old_value, new_value, changed_by)
                     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                    [taskId, log.action, log.old_value, log.new_value, userId]
                );
            });
            const logResults = await Promise.all(logPromises);
             const savedLogs = logResults.map(res => res.rows[0]);
            // Fetch username for logs and emit log events
            const changerDetails = await getUserDetails(userId, client);
            for (const savedLog of savedLogs) {
                const logEventPayload = {
                    ...savedLog,
                    log_id: savedLog.id, // Ensure correct field name
                    changed_by_username: changerDetails.username,
                    changed_at: new Date(savedLog.changed_at).toISOString(),
                };
                const logTargetRoom = `task_${taskId}`;
                // console.log(`[Socket Emit] Event: newLogEntry | Target: Room ${logTargetRoom}`); // Лог внутри сервиса
                // io.to(logTargetRoom).emit('newLogEntry', logEventPayload);
                socketService.emitToRoom(logTargetRoom, 'newLogEntry', logEventPayload);
                // console.log(`Event newLogEntry emitted for task ${taskId}, log ${savedLog.id}`);
            }
        }

        await client.query('COMMIT'); // Фиксируем транзакцию

        // Fetch final usernames for the event/response payload
        const finalCreatorDetails = await getUserDetails(updatedTask.creator_id, client); // Use client for consistency within transaction
        const finalAssigneeDetails = await getUserDetails(updatedTask.assignee_id, client);

        // Emit update event to relevant rooms
        const taskUpdatedPayload = {
            ...updatedTask,
            creator_username: finalCreatorDetails.username,
            assignee_username: finalAssigneeDetails.username,
            due_date: updatedTask.due_date ? new Date(updatedTask.due_date).toISOString() : null,
            created_at: new Date(updatedTask.created_at).toISOString(),
            updated_at: new Date(updatedTask.updated_at).toISOString(),
        };
        const taskRoom = `task_${taskId}`;
        // console.log(`[Socket Emit] Event: taskUpdated | Target: Room general_tasks`); // Лог внутри сервиса
        // io.to('general_tasks').emit('taskUpdated', taskUpdatedPayload);
        socketService.emitToRoom('general_tasks', 'taskUpdated', taskUpdatedPayload);
        // console.log(`[Socket Emit] Event: taskUpdated | Target: Room ${taskRoom}`); // Лог внутри сервиса
        // io.to(taskRoom).emit('taskUpdated', taskUpdatedPayload);
        socketService.emitToRoom(taskRoom, 'taskUpdated', taskUpdatedPayload);
        // console.log(`Event taskUpdated emitted for task ${taskId} to general_tasks and task_${taskId}`);

        res.status(200).json(taskUpdatedPayload); // Send updated task with usernames
        console.log(`Задача ID: ${taskId} успешно обновлена пользователем ${userId}.`);

    } catch (error: any) {
        if (client) {
            await client.query('ROLLBACK'); // Откатываем транзакцию в случае любой ошибки
            console.error(`Транзакция обновления задачи ${taskId} отменена из-за ошибки.`);
        }
        console.error(`Ошибка при обновлении задачи ID ${taskId}:`, error);
        if (error.code === '22P02') { // Invalid UUID format for task id or assignee_id
            res.status(400).json({ error: 'Неверный формат ID задачи или исполнителя.' });
        } else if (error.code === '23503') { // Foreign key violation (e.g., invalid assignee_id)
            res.status(400).json({ error: 'Указан неверный ID исполнителя.' });
        } else {
             res.status(500).json({ error: 'Не удалось обновить задачу' });
        }
    } finally {
        if (client) {
            client.release(); // Возвращаем клиента в пул
            console.log(`Клиент базы данных освобожден после обновления задачи ${taskId}.`);
        }
    }
};


// Функция для удаления задачи
export const deleteTask = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { id: taskId } = req.params; // Rename id to taskId

    console.log(`Попытка удаления задачи ID: ${taskId} пользователем ${userId}.`);

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
        // console.log(`[Socket Emit] Event: taskDeleted | Target: Room general_tasks`); // Лог внутри сервиса
        // io.to('general_tasks').emit('taskDeleted', eventPayloadDelete);
        socketService.emitToRoom('general_tasks', 'taskDeleted', eventPayloadDelete);
        // console.log(`[Socket Emit] Event: taskDeleted | Target: Room ${taskRoomDelete}`); // Лог внутри сервиса
        // io.to(taskRoomDelete).emit('taskDeleted', eventPayloadDelete);
        socketService.emitToRoom(taskRoomDelete, 'taskDeleted', eventPayloadDelete);
         console.log(`Event taskDeleted emitted for task ${taskId} to general_tasks and task_${taskId}`);

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
    const { id: taskId } = req.params; // ID задачи
    const { comment } = req.body;

     console.log(`Попытка добавить комментарий к задаче ID: ${taskId} пользователем ${commenter_id}.`);

    if (!commenter_id) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId || !comment) {
        res.status(400).json({ error: 'Необходимо указать ID задачи и текст комментария.' });
        return;
    }

    let client: PoolClient | null = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // 1. Проверяем существование задачи и права доступа (комментировать может создатель или исполнитель)
        const taskResult = await client.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskResult.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка комментировать несуществующую задачу ID: ${taskId} пользователем ${commenter_id}`);
            client.release();
            return;
        }
        // const task = taskResult.rows[0];
        // if (task.creator_id !== commenter_id && task.assignee_id !== commenter_id) {
        //     await client.query('ROLLBACK');
        //     res.status(403).json({ error: 'У вас нет прав комментировать эту задачу.' });
        //      console.log(`Пользователь ${commenter_id} пытался комментировать задачу ${taskId}, к которой не имеет отношения.`);
        //      client.release();
        // }

        // 2. Добавляем комментарий
        const insertResult = await client.query(
            `INSERT INTO task_comments (task_id, commenter_id, comment) VALUES ($1, $2, $3) RETURNING *`,
            [taskId, commenter_id, comment]
        );
        const newComment = insertResult.rows[0];

        await client.query('COMMIT');

        // Fetch commenter username for the event payload
        const commenterDetails = await getUserDetails(newComment.commenter_id); // Fetch outside transaction

        // Emit event to the specific task room
        const eventPayload = {
            ...newComment,
            commenter_username: commenterDetails.username,
            created_at: new Date(newComment.created_at).toISOString(),
        };
        const commentTargetRoom = `task_${taskId}`;
        // console.log(`[Socket Emit] Event: newTaskComment | Target: Room ${commentTargetRoom}`); // Лог внутри сервиса
        // io.to(commentTargetRoom).emit('newTaskComment', eventPayload);
        socketService.emitToRoom(commentTargetRoom, 'newTaskComment', eventPayload);
        // console.log(`Event newTaskComment emitted for task ${taskId}, comment ${newComment.id}`);

        res.status(201).json(eventPayload); // Возвращаем созданный комментарий с именем пользователя
        console.log(`Комментарий ID ${newComment.id} добавлен к задаче ${taskId} пользователем ${commenter_id}.`);

    } catch (error: any) {
        if (client) {
            await client.query('ROLLBACK');
            console.error(`Транзакция добавления комментария к задаче ${taskId} отменена из-за ошибки.`);
        }
        console.error(`Ошибка при добавлении комментария к задаче ${taskId}:`, error);
        if (error.code === '22P02') { // Invalid UUID format for task id
             res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else if (error.code === '23503') { // Foreign key violation (task_id or commenter_id)
             res.status(404).json({ error: 'Указана неверная задача или пользователь.' });
        } else {
            res.status(500).json({ error: 'Не удалось добавить комментарий' });
        }
    } finally {
        if (client) {
            client.release();
             console.log(`Клиент базы данных освобожден после добавления комментария к задаче ${taskId}.`);
        }
    }
};

// Функция для получения комментариев к задаче
export const getTaskComments = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { id: taskId } = req.params;

    console.log(`Запрос комментариев к задаче ID: ${taskId} пользователем ${userId}.`);

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
        return;
    }

    try {
        // 1. Проверяем существование задачи и права доступа (просматривать может создатель или исполнитель)
        const taskResult = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskResult.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка получить комментарии несуществующей задачи ID: ${taskId} пользователем ${userId}`);
            return;
        }
        // const task = taskResult.rows[0];
        // if (task.creator_id !== userId && task.assignee_id !== userId) {
        //     res.status(403).json({ error: 'У вас нет прав просматривать комментарии этой задачи.' });
        //     console.log(`Пользователь ${userId} пытался получить комментарии задачи ${taskId}, к которой не имеет отношения.`);
        //     return;
        // }

        // 2. Получаем комментарии с именами пользователей
        const commentsResult = await pool.query(
            `SELECT tc.*, u.username AS commenter_username
             FROM task_comments tc
             JOIN users u ON tc.commenter_id = u.id
             WHERE tc.task_id = $1
             ORDER BY tc.created_at ASC`,
            [taskId]
        );

         // Ensure dates are in ISO 8601 format
        const commentsWithIsoDates = commentsResult.rows.map(comment => ({
            ...comment,
            created_at: new Date(comment.created_at).toISOString(),
        }));

        res.status(200).json(commentsWithIsoDates);
        console.log(`Получены комментарии (${commentsResult.rowCount}) для задачи ${taskId} пользователем ${userId}.`);

    } catch (error: any) {
        console.error(`Ошибка при получении комментариев задачи ${taskId}:`, error);
        if (error.code === '22P02') { // Invalid UUID format for task id
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
    const { id: taskId } = req.params;
    const file = req.file; // Получаем файл из multer

    console.log(`Попытка добавить вложение к задаче ID: ${taskId} пользователем ${uploader_id}. Файл:`, file);

    if (!uploader_id) {
        // Если файл был загружен, но пользователь не аутентифицирован, удаляем файл
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
            file_size: newAttachment.file_size,
            upload_date: new Date(newAttachment.created_at).toISOString(), // Use created_at as upload_date
            uploaded_by: newAttachment.uploader_id,
            uploaded_by_username: uploaderDetails.username,
            // Construct download URL (adjust path as needed)
            download_url: `/tasks/${taskId}/attachments/${newAttachment.id}/download`
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
    const { id: taskId } = req.params;

    console.log(`Запрос вложений задачи ID: ${taskId} пользователем ${userId}.`);

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
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
            file_size: att.file_size,
            upload_date: new Date(att.created_at).toISOString(),
            uploaded_by: att.uploader_id,
            uploaded_by_username: att.uploaded_by_username,
            download_url: `/tasks/${taskId}/attachments/${att.id}/download`
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
     const userId = req.user?.id;
     const { id: taskId, attachmentId } = req.params;

     console.log(`Запрос на скачивание вложения ID: ${attachmentId} задачи ${taskId} пользователем ${userId}.`);

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

     if (!taskId || !attachmentId) {
        res.status(400).json({ error: 'Не указан ID задачи или вложения.' });
        return;
    }

    try {
        // 1. Проверяем существование задачи и права доступа (скачивать может создатель или исполнитель)
         const taskResult = await pool.query('SELECT creator_id, assignee_id FROM tasks WHERE id = $1', [taskId]);
        if (taskResult.rows.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
             console.log(`Попытка скачать вложение ${attachmentId} несуществующей задачи ${taskId} пользователем ${userId}`);
            return;
        }
        // const task = taskResult.rows[0];
        // if (task.creator_id !== userId && task.assignee_id !== userId) {
        //      res.status(403).json({ error: 'У вас нет прав скачивать вложения этой задачи.' });
        //      console.log(`Пользователь ${userId} пытался скачать вложение ${attachmentId} задачи ${taskId}, к которой не имеет отношения.`);
        //     return;
        // }

        // 2. Получаем информацию о файле
        const fileResult = await pool.query('SELECT file_path, file_name FROM task_attachments WHERE id = $1 AND task_id = $2', [attachmentId, taskId]);

        if (fileResult.rows.length === 0) {
            res.status(404).json({ error: 'Вложение не найдено для этой задачи.' });
            console.log(`Вложение ID ${attachmentId} не найдено для задачи ${taskId}.`);
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
        console.error(`Ошибка при скачивании вложения ${attachmentId} задачи ${taskId}:`, error);
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
    const { id: taskId, attachmentId } = req.params;

    console.log(`Попытка удаления вложения ID: ${attachmentId} задачи ${taskId} пользователем ${userId}.`);

     if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId || !attachmentId) {
        res.status(400).json({ error: 'Не указан ID задачи или вложения.' });
        return;
    }

    let client: PoolClient | null = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

         // 1. Проверяем существование задачи и права доступа (удалять может создатель или исполнитель)
         //    А также получаем путь к файлу для удаления с диска
         const attachmentResult = await client.query(
            `SELECT ta.file_path, ta.uploader_id, t.creator_id, t.assignee_id
             FROM task_attachments ta
             JOIN tasks t ON ta.task_id = t.id
             WHERE ta.id = $1 AND ta.task_id = $2`,
            [attachmentId, taskId]
        );

        if (attachmentResult.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'Вложение не найдено или не принадлежит указанной задаче.' });
            console.log(`Попытка удалить несуществующее/неверное вложение ${attachmentId} задачи ${taskId}`);
            client.release();
            return;
        }

        const { file_path, uploader_id, creator_id, assignee_id } = attachmentResult.rows[0];

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
        const absolutePath = path.resolve(file_path);
        try {
            if (fs.existsSync(absolutePath)) {
                fs.unlinkSync(absolutePath);
                console.log(`Файл вложения удален с диска: ${absolutePath}`);
            } else {
                 console.warn(`Файл вложения для удаления не найден на диске: ${absolutePath}`);
            }
        } catch (fsError) {
            console.error(`Ошибка при удалении файла вложения ${absolutePath} с диска (запись в БД уже удалена):`, fsError);
            // Не откатываем транзакцию, т.к. запись в БД уже удалена
        }

        await client.query('COMMIT');

        // Emit event to the specific task room
        const eventPayload = {
            taskId: taskId,
            attachmentId: attachmentId,
        };
        const deleteAttachmentTargetRoom = `task_${taskId}`;
        // console.log(`[Socket Emit] Event: taskAttachmentDeleted | Target: Room ${deleteAttachmentTargetRoom}`); // Лог внутри сервиса
        // io.to(deleteAttachmentTargetRoom).emit('taskAttachmentDeleted', eventPayload);
        socketService.emitToRoom(deleteAttachmentTargetRoom, 'taskAttachmentDeleted', eventPayload);
        // console.log(`Event taskAttachmentDeleted emitted for task ${taskId}, attachment ${attachmentId}`);

        res.status(200).json({ message: 'Вложение успешно удалено.', taskId, attachmentId });
        console.log(`Вложение ID ${attachmentId} задачи ${taskId} успешно удалено пользователем ${userId}.`);

    } catch (error: any) {
         if (client) {
            await client.query('ROLLBACK');
             console.error(`Транзакция удаления вложения ${attachmentId} задачи ${taskId} отменена.`);
        }
        console.error(`Ошибка при удалении вложения ${attachmentId} задачи ${taskId}:`, error);
        if (error.code === '22P02') { // Invalid UUID format
            res.status(400).json({ error: 'Неверный формат ID задачи или вложения.' });
        } else {
            res.status(500).json({ error: 'Не удалось удалить вложение' });
        }
    } finally {
        if (client) {
            client.release();
             console.log(`Клиент базы данных освобожден после удаления вложения ${attachmentId} задачи ${taskId}.`);
        }
    }
};

// --- Логи изменений задач ---

// Функция для получения логов задачи
export const getTaskLogs = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { id: taskId } = req.params;

    console.log(`Запрос логов задачи ID: ${taskId} пользователем ${userId}.`);

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId) {
        res.status(400).json({ error: 'Не указан ID задачи.' });
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
            log_id: log.id, // Map database id to log_id
            task_id: log.task_id,
            action: log.action,
            old_value: log.old_value,
            new_value: log.new_value,
            changed_by: log.changed_by,
            changed_by_username: log.changed_by_username,
            changed_at: new Date(log.changed_at).toISOString(),
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

