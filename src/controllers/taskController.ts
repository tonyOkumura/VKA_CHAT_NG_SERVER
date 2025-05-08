import { Request, Response } from 'express';
import knex from '../lib/knex';
import type { Knex as KnexType } from 'knex';
import path from 'path';
import fs from 'fs';
import * as socketService from '../services/socketService';
import * as fileService from '../services/fileService';
import { getUserDetailsWithAvatar } from '../lib/dbHelpers';

const validStatuses = ['open', 'in_progress', 'done', 'closed'];
const validPriorities = [1, 2, 3, 4, 5];

export const createTask = async (req: Request, res: Response): Promise<void> => {
    const { title, description, status, priority, assignee_id, due_date } = req.body;
    const creator_id = req.user?.id;

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
        const insertedTasks = await knex('tasks')
            .insert({
                title,
                description,
                status: status || 'open',
                priority: priority || 3,
                creator_id,
                assignee_id,
                due_date
            })
            .returning('*');

        const newTask = insertedTasks[0];
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
        if (error.code === '23503' && error.constraint === 'tasks_assignee_id_fkey') {
            res.status(400).json({ error: 'Указанный исполнитель не найден.' });
        } else {
            res.status(500).json({ error: 'Не удалось создать задачу' });
        }
    }
};

// Получение списка задач
export const getTasks = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
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
        const query = knex('tasks as t')
            .select(
                't.*',
                'creator.username as creator_username',
                'assignee.username as assignee_username',
                'creator_avatar.file_path as creatorAvatarPath',
                'assignee_avatar.file_path as assigneeAvatarPath'
            )
            .leftJoin('users as creator', 't.creator_id', 'creator.id')
            .leftJoin('users as assignee', 't.assignee_id', 'assignee.id')
            .leftJoin('user_avatars as creator_avatar', 't.creator_id', 'creator_avatar.user_id')
            .leftJoin('user_avatars as assignee_avatar', 't.assignee_id', 'assignee_avatar.user_id')
            .where(function() {
                this.where('t.creator_id', userId)
                    .orWhere('t.assignee_id', userId);
            });

        if (status) {
            if (!validStatuses.includes(status as string)) {
                res.status(400).json({ error: `Статус должен быть одним из: ${validStatuses.join(', ')}.` });
                return;
            }
            query.andWhere('t.status', status as string);
        }

        if (search) {
            query.andWhere(function() {
                this.where('t.title', 'ILIKE', `%${search}%`)
                    .orWhere('t.description', 'ILIKE', `%${search}%`);
            });
        }

        const tasksData = await query.orderBy('t.created_at', 'desc').limit(limitNum).offset(offset);

        const tasks = tasksData.map(task => ({
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
    const userId = req.user?.id;
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
        const task = await knex('tasks as t')
            .select(
                't.*',
                'creator.username as creator_username',
                'assignee.username as assignee_username',
                'creator_avatar.file_path as creatorAvatarPath',
                'assignee_avatar.file_path as assigneeAvatarPath'
            )
            .leftJoin('users as creator', 't.creator_id', 'creator.id')
            .leftJoin('users as assignee', 't.assignee_id', 'assignee.id')
            .leftJoin('user_avatars as creator_avatar', 't.creator_id', 'creator_avatar.user_id')
            .leftJoin('user_avatars as assignee_avatar', 't.assignee_id', 'assignee_avatar.user_id')
            .where('t.id', taskId)
            .first();

        if (!task) {
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка доступа к несуществующей задаче ID: ${taskId} пользователем ${userId}`);
            return;
        }

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

// Helper to check if user is creator or assignee of a task
const isUserTaskParticipant = async (userId: string, taskId: string, trx?: KnexType | KnexType.Transaction): Promise<boolean> => {
    const db = trx || knex;
    const task = await db('tasks')
        .select('creator_id', 'assignee_id')
        .where('id', taskId)
        .first();
    return !!task && (task.creator_id === userId || task.assignee_id === userId);
};

// Обновление задачи
export const updateTask = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
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
    const logEntriesData: Array<{ action: string, old_value: string | null, new_value: string | null }> = [];

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

    try {
        const resultTask = await knex.transaction(async (trx) => {
            const currentTask = await trx('tasks')
                .select('*') 
                .where('id', taskId)
                .first();

            if (!currentTask) {
                throw { status: 404, message: 'Задача для обновления не найдена.' };
            }

            if (currentTask.creator_id !== userId && currentTask.assignee_id !== userId) {
                 throw { status: 403, message: 'Вы не можете обновлять эту задачу.' };
            }

            Object.keys(updatesToApply).forEach(key => {
                const oldValue = currentTask[key];
                const newValue = updatesToApply[key];
                const oldValueComparable = oldValue instanceof Date ? oldValue.toISOString() : oldValue;
                const newValueComparable = newValue instanceof Date ? new Date(newValue).toISOString() : newValue;
                if (String(oldValueComparable ?? null) !== String(newValueComparable ?? null)) {
                    let actionText = `Изменено поле ${key}`;
                    if (key === 'assignee_id') actionText = 'Изменен исполнитель';
                    if (key === 'status') actionText = 'Изменен статус';
                    if (key === 'priority') actionText = 'Изменен приоритет';
                    if (key === 'due_date') actionText = 'Изменен срок выполнения';
                    logEntriesData.push({
                        action: actionText,
                        old_value: oldValueComparable === undefined ? null : String(oldValueComparable ?? null),
                        new_value: newValueComparable === undefined ? null : String(newValueComparable ?? null)
                    });
                }
            });
            if (Object.keys(updatesToApply).length > 0 && logEntriesData.length === 0) {
                 const creatorDetailsNoChange = await getUserDetailsWithAvatar(currentTask.creator_id, trx);
                 const assigneeDetailsNoChange = await getUserDetailsWithAvatar(currentTask.assignee_id, trx);
                 return {
                    ...currentTask,
                    creator_username: creatorDetailsNoChange.username,
                    assignee_username: assigneeDetailsNoChange.username,
                    creatorAvatarPath: creatorDetailsNoChange.avatarPath,
                    assigneeAvatarPath: assigneeDetailsNoChange.avatarPath,
                    due_date: currentTask.due_date ? new Date(currentTask.due_date).toISOString() : null,
                    created_at: new Date(currentTask.created_at).toISOString(),
                    updated_at: new Date(currentTask.updated_at).toISOString(),
                    _no_changes_applied: true 
                };
            }
            if (logEntriesData.length > 0) {
                updatesToApply.updated_at = new Date(); 
                await trx('tasks')
                    .where('id', taskId)
                    .update(updatesToApply);
                const logInserts = logEntriesData.map(log => ({
                    task_id: taskId,
                    action: log.action,
                    old_value: log.old_value,
                    new_value: log.new_value,
                    changed_by: userId
                }));
                await trx('task_logs').insert(logInserts);
            }
            const finalTaskData = await trx('tasks').where('id', taskId).first();
            if (!finalTaskData) throw { status: 500, message: 'Ошибка получения обновленной задачи.'};
            const creatorDetails = await getUserDetailsWithAvatar(finalTaskData.creator_id, trx);
            const assigneeDetails = await getUserDetailsWithAvatar(finalTaskData.assignee_id, trx);
            return {
                ...finalTaskData,
                creator_username: creatorDetails.username,
                assignee_username: assigneeDetails.username,
                creatorAvatarPath: creatorDetails.avatarPath,
                assigneeAvatarPath: assigneeDetails.avatarPath,
                due_date: finalTaskData.due_date ? new Date(finalTaskData.due_date).toISOString() : null,
                created_at: new Date(finalTaskData.created_at).toISOString(),
                updated_at: new Date(finalTaskData.updated_at).toISOString(),
            };
        });
        if (resultTask._no_changes_applied) {
            res.status(200).json({ message: 'Нет изменений для применения.', task: resultTask });
            console.log(`Task ${taskId} update requested by ${userId}, but no actual changes detected.`);
        } else if (resultTask) {
            const changerDetails = await getUserDetailsWithAvatar(userId); 
            const eventPayload = {
                ...resultTask,
                change_details: logEntriesData, 
                changed_by: {
                    user_id: changerDetails.id,
                    username: changerDetails.username,
                    avatarPath: changerDetails.avatarPath
                },
            };
            const taskRoom = `task_${taskId}`;
            socketService.emitToRoom(taskRoom, 'taskUpdated', eventPayload);
            socketService.emitToRoom('general_tasks', 'taskUpdated', eventPayload);
            res.status(200).json(resultTask);
            console.log(`Задача ID: ${taskId} успешно обновлена пользователем ${userId}`);
        } else {
            res.status(500).json({ error: 'Не удалось обновить задачу' });
        }
    } catch (error: any) {
        console.error(`Ошибка при обновлении задачи ID ${taskId}:`, error);
        const status = error.status || 500;
        const message = error.message || (error.code === '22P02' ? 'Неверный формат ID задачи или исполнителя.' : error.code === '23503' ? 'Указанный исполнитель не найден.' : 'Не удалось обновить задачу');
        if (!res.headersSent) {
            res.status(status).json({ error: message });
        }
    }
};

// Удаление задачи
export const deleteTask = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
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
        await knex.transaction(async (trx) => {
            const task = await trx('tasks')
                .select('creator_id', 'assignee_id')
                .where('id', taskId)
                .first();

            if (!task) {
                throw { status: 404, message: 'Задача не найдена.' };
            }
            if (task.creator_id !== userId && task.assignee_id !== userId) {
                throw { status: 403, message: 'У вас нет прав на удаление этой задачи.' };
            }

            const attachments = await trx('task_attachments')
                .select('id', 'file_path')
                .where('task_id', taskId);

            // Delete files from disk first
            for (const attachment of attachments) {
                try {
                    await fileService.deleteFileFromDiskByDbPath(attachment.file_path);
                    console.log(`Task attachment file ${attachment.file_path} deleted from disk.`);
                } catch (diskError: any) {
                    // Log error but continue to delete DB records
                    console.error(`Error deleting task attachment file ${attachment.file_path} from disk:`, diskError);
                }
            }
            
            // Cascade deletes are not explicitly set up for task_logs, task_comments, task_attachments in the provided SQL,
            // so manually delete them before deleting the task.
            await trx('task_logs').where('task_id', taskId).del();
            await trx('task_comments').where('task_id', taskId).del();
            await trx('task_attachments').where('task_id', taskId).del();

            const deleteResult = await trx('tasks')
                .where('id', taskId)
                .del();

            if (deleteResult === 0) {
                throw { status: 404, message: 'Не удалось найти задачу для удаления после проверки.' };
            }
        });

        const eventPayloadDelete = { taskId: taskId };
        const taskRoomDelete = `task_${taskId}`;
        socketService.emitToRoom(taskRoomDelete, 'taskDeleted', eventPayloadDelete);
        socketService.emitToRoom('general_tasks', 'taskDeleted', eventPayloadDelete);

        res.status(200).json({ message: 'Задача и все связанные данные успешно удалены.', taskId: taskId });
        console.log(`Задача ID: ${taskId} успешно удалена пользователем ${userId}.`);

    } catch (error: any) {
        console.error(`Ошибка при удалении задачи ID ${taskId}:`, error);
        const status = error.status || 500;
        const message = error.message || (error.code === '22P02' ? 'Неверный формат ID задачи.' : 'Не удалось удалить задачу');
        if (!res.headersSent) {
            res.status(status).json({ error: message });
        }
    }
};

// Добавление комментария
export const addTaskComment = async (req: Request, res: Response): Promise<void> => {
    const commenter_id = req.user?.id;
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
        const taskData = await knex('tasks')
            .select('creator_id', 'assignee_id')
            .where('id', taskId)
            .first();

        if (!taskData) {
            res.status(404).json({ error: 'Задача не найдена.' });
            return;
        }
        
        if (taskData.creator_id !== commenter_id && taskData.assignee_id !== commenter_id) {
            res.status(403).json({ error: 'Вы не можете комментировать эту задачу.' });
            return;
        }

        const insertedComments = await knex('task_comments')
            .insert({
                task_id: taskId,
                commenter_id,
                comment
            })
            .returning('*');
        
        const newComment = insertedComments[0];

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
        if (error.code === '23503') { // foreign key violation
            res.status(404).json({ error: 'Задача или пользователь не найдены.' });
        } else if (error.code === '22P02') { // invalid input syntax for type uuid
            res.status(400).json({ error: 'Неверный формат ID задачи.' });
        } else {
            res.status(500).json({ error: 'Не удалось добавить комментарий' });
        }
    }
};

// Получение комментариев
export const getTaskComments = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
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
        const taskData = await knex('tasks')
            .select('creator_id', 'assignee_id')
            .where('id', taskId)
            .first();

        if (!taskData) {
            res.status(404).json({ error: 'Задача не найдена.' });
            return;
        }
        
        if (taskData.creator_id !== userId && taskData.assignee_id !== userId) {
            res.status(403).json({ error: 'Вы не можете просматривать комментарии к этой задаче.' });
            return;
        }

        const commentsData = await knex('task_comments as tc')
            .select(
                'tc.*',
                'u.username as commenter_username',
                'ua.file_path as commenterAvatarPath'
            )
            .leftJoin('users as u', 'tc.commenter_id', 'u.id')
            .leftJoin('user_avatars as ua', 'tc.commenter_id', 'ua.user_id')
            .where('tc.task_id', taskId)
            .orderBy('tc.created_at', 'asc');

        const comments = commentsData.map(comment => ({
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
    const uploader_id = req.user?.id;
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

    let client: KnexType.Transaction | null = null;
    try {
        client = await knex.transaction();
        const taskResult = await client('tasks')
            .select('creator_id', 'assignee_id')
            .where('id', taskId)
            .first();
        if (taskResult.length === 0) {
            await client.rollback();
            fs.unlinkSync(file.path);
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка добавить вложение к несуществующей задаче ID: ${taskId} пользователем ${uploader_id}`);
            return;
        }
        const task = taskResult[0];
        if (task.creator_id !== uploader_id && task.assignee_id !== uploader_id) {
            await client.rollback();
            fs.unlinkSync(file.path);
            res.status(403).json({ error: 'У вас нет прав добавлять вложения к этой задаче.' });
            console.log(`Пользователь ${uploader_id} пытался добавить вложение к задаче ${taskId}, к которой не имеет отношения.`);
            return;
        }

        const { originalname, path: filePath, mimetype, size } = file;
        if (size > 10 * 1024 * 1024) { // 10 MB limit
            await client.rollback();
            fs.unlinkSync(filePath);
            res.status(400).json({ error: 'Размер файла превышает 10 МБ.' });
            return;
        }

        const insertResult = await client('task_attachments')
            .insert({
                task_id: taskId,
                file_name: originalname,
                file_path: filePath,
                file_type: mimetype,
                file_size: size,
                uploader_id
            })
            .returning('*');
        const newAttachment = insertResult[0];

        await client.commit();

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
            await client.rollback();
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
    }
};

// Получение вложений
export const getTaskAttachments = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
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
        const taskResult = await knex('tasks')
            .select('creator_id', 'assignee_id')
            .where('id', taskId)
            .first();
        if (taskResult.length === 0) {
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка получить вложения несуществующей задачи ID: ${taskId} пользователем ${userId}`);
            return;
        }
        const task = taskResult[0];
        if (task.creator_id !== userId && task.assignee_id !== userId) {
            res.status(403).json({ error: 'У вас нет прав на просмотр вложений этой задачи.' });
            console.log(`Пользователь ${userId} пытался получить вложения задачи ${taskId}, к которой не имеет отношения.`);
            return;
        }

        const result = await knex('task_attachments as ta')
            .select(
                'ta.*',
                'u.username as uploaded_by_username'
            )
            .leftJoin('users as u', 'ta.uploader_id', 'u.id')
            .where('ta.task_id', taskId)
            .orderBy('ta.created_at', 'asc');

        const attachments = result.map(attachment => ({
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
    const userId = req.user?.id;
    const { taskId, attachmentId } = req.body;

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    if (!taskId || !attachmentId) {
        res.status(400).json({ error: 'Не указан ID задачи или вложения в теле запроса.' });
        return;
    }

    let client: KnexType.Transaction | null = null;

    try {
        client = await knex.transaction();
        const taskResult = await client('tasks')
            .select('creator_id', 'assignee_id')
            .where('id', taskId)
            .first();
        if (taskResult.length === 0) {
            await client.rollback();
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка удалить вложение из несуществующей задачи ID: ${taskId} пользователем ${userId}`);
            return;
        }
        const task = taskResult[0];
        if (task.creator_id !== userId && task.assignee_id !== userId) {
            await client.rollback();
            res.status(403).json({ error: 'У вас нет прав на удаление вложений этой задачи.' });
            console.log(`Пользователь ${userId} пытался удалить вложение ${attachmentId} из задачи ${taskId}, к которой не имеет отношения.`);
            return;
        }

        const attachmentResult = await client('task_attachments')
            .select('file_path')
            .where('id', attachmentId)
            .andWhere('task_id', taskId)
            .first();
        if (!attachmentResult) {
            await client.rollback();
            res.status(404).json({ error: 'Вложение не найдено.' });
            console.log(`Попытка удалить несуществующее вложение ID: ${attachmentId} для задачи ${taskId}`);
            return;
        }

        const filePath = attachmentResult.file_path;
        const deleteResult = await client('task_attachments')
            .where('id', attachmentId)
            .andWhere('task_id', taskId)
            .del()
            .returning('id');

        if (deleteResult.length === 0) {
            await client.rollback();
            res.status(404).json({ error: 'Не удалось удалить вложение.' });
            console.log(`Не удалось удалить вложение ID: ${attachmentId} для задачи ${taskId}`);
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

        await client.commit();

        const eventPayload = { taskId, attachmentId };
        const taskRoom = `task_${taskId}`;
        socketService.emitToRoom(taskRoom, 'taskAttachmentDeleted', eventPayload);

        res.status(200).json({ message: 'Вложение успешно удалено.', attachmentId });
        console.log(`Вложение ID ${attachmentId} удалено из задачи ${taskId} пользователем ${userId}`);
    } catch (error: any) {
        if (client) {
            await client.rollback();
            console.error(`Транзакция удаления вложения ${attachmentId} отменена из-за ошибки.`);
        }
        console.error(`Ошибка при удалении вложения ${attachmentId} задачи ${taskId}:`, error);
        if (error.code === '22P02') {
            res.status(400).json({ error: 'Неверный формат ID задачи или вложения.' });
        } else {
            res.status(500).json({ error: 'Не удалось удалить вложение' });
        }
    }
};

// Скачивание вложения (URL /download_body/:attachmentId)
export const downloadTaskAttachment = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { attachmentId } = req.params; 

    if (!userId) {
        res.status(401).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }
    if (!attachmentId) {
        res.status(400).json({ error: 'Не указан ID вложения.' });
        return;
    }

    try {
        // --- Logic for getTaskFileDetailsForDownload (inline) ---
        const attachment = await knex('task_attachments as ta')
            .select(
                'ta.file_path as filePathInDb',
                'ta.file_name as originalName',
                'ta.file_type as mimeType',
                'ta.task_id'
            )
            .where('ta.id', attachmentId)
            .first();

        if (!attachment) {
            res.status(404).json({ error: 'Вложение не найдено.' });
            return;
        }

        const canAccess = await isUserTaskParticipant(userId, attachment.task_id);
        if (!canAccess) {
            res.status(403).json({ error: 'Доступ к файлу запрещен.' });
            return;
        }
        // --- End of inline logic ---
        
        const absolutePathOnDisk = path.join(process.cwd(), attachment.filePathInDb);
        
        if (!fs.existsSync(absolutePathOnDisk)) {
            console.error(`Task attachment file not found on disk: ${absolutePathOnDisk} (DB path: ${attachment.filePathInDb})`);
            res.status(404).json({ error: 'Файл не найден на сервере.' });
            return;
        }

        res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(attachment.originalName)}"`);

        const fileStream = fs.createReadStream(absolutePathOnDisk);
        fileStream.on('error', (streamError) => {
            console.error('Error streaming task attachment to response:', streamError);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Не удалось отправить файл' });
            }
        });
        fileStream.pipe(res);

    } catch (error: any) {
        console.error(`Ошибка при скачивании вложения ${attachmentId}:`, error);
        if (!res.headersSent) {
            if (error.code === '22P02') { 
                res.status(400).json({ error: 'Неверный формат ID вложения.' });
            } else {
                res.status(500).json({ error: 'Не удалось скачать вложение' });
            }
        }
    }
};

// Получение информации о конкретном вложении (URL /info/:attachmentId)
export const getTaskAttachmentInfo = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { attachmentId } = req.params; 

    if (!userId) {
        res.status(401).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }
    if (!attachmentId) {
        res.status(400).json({ error: 'Не указан ID вложения.' });
        return;
    }

    try {
        const attachmentDetails = await knex('task_attachments as ta')
            .select(
                'ta.id',
                'ta.task_id',
                'ta.file_name',
                'ta.file_type',
                'ta.file_size',
                'ta.created_at'
            )
            .where('ta.id', attachmentId)
            .first();

        if (!attachmentDetails) {
            res.status(404).json({ error: 'Вложение не найдено.' });
            return;
        }

        const canAccess = await isUserTaskParticipant(userId, attachmentDetails.task_id);
        if (!canAccess) {
            res.status(403).json({ error: 'Доступ к информации о вложении запрещен.' });
            return;
        }

        res.json({
            id: attachmentDetails.id,
            task_id: attachmentDetails.task_id,
            file_name: attachmentDetails.file_name,
            file_type: attachmentDetails.file_type,
            file_size: attachmentDetails.file_size,
            created_at: new Date(attachmentDetails.created_at).toISOString(),
            download_url: `/api/tasks/attachments/download_body/${attachmentDetails.id}`
        });
        console.log(`Информация о вложении ID ${attachmentId} для задачи ${attachmentDetails.task_id} получена пользователем ${userId}`);
    } catch (error: any) {
        console.error(`Ошибка при получении информации о вложении ${attachmentId}:`, error);
        if (!res.headersSent) {
            if (error.code === '22P02') {
                res.status(400).json({ error: 'Неверный формат ID вложения или задачи.' });
            } else {
                res.status(500).json({ error: 'Не удалось получить информацию о вложении' });
            }
        }
    }
};

// Получение логов изменений
export const getTaskLogs = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
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
        const taskData = await knex('tasks')
            .select('creator_id', 'assignee_id')
            .where('id', taskId)
            .first();

        if (!taskData) {
            res.status(404).json({ error: 'Задача не найдена.' });
            console.log(`Попытка получить логи несуществующей задачи ID: ${taskId} пользователем ${userId}`);
            return;
        }
        
        if (taskData.creator_id !== userId && taskData.assignee_id !== userId) {
            res.status(403).json({ error: 'Вы не можете просматривать логи этой задачи.' });
            console.log(`Пользователь ${userId} пытался получить логи задачи ${taskId}, к которой не имеет отношения.`);
            return;
        }

        const logsData = await knex('task_logs as tl')
            .select(
                'tl.id as logId', // Alias id to logId
                'tl.task_id',
                'tl.action',
                'tl.old_value',
                'tl.new_value',
                'tl.changed_by as user_id', // Alias changed_by to user_id
                'u.username',
                'tl.created_at as timestamp' // Alias created_at to timestamp
            )
            .leftJoin('users as u', 'tl.changed_by', 'u.id')
            .where('tl.task_id', taskId)
            .orderBy('tl.created_at', 'asc');

        const logs = logsData.map(log => ({
            ...log,
            timestamp: new Date(log.timestamp).toISOString(), // Ensure correct timestamp format
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
    const userId = req.user?.id;
    const { status, startDate, endDate } = req.query;

    if (!userId) {
        res.status(403).json({ error: 'Пользователь не аутентифицирован.' });
        return;
    }

    try {
        const query = knex('tasks as t')
            .select(
                't.id',
                't.title',
                't.description',
                't.status',
                't.priority',
                't.creator_id',
                'creator.username as creator_username',
                't.assignee_id',
                'assignee.username as assignee_username',
                't.due_date',
                't.created_at',
                't.updated_at'
            )
            .leftJoin('users as creator', 't.creator_id', 'creator.id')
            .leftJoin('users as assignee', 't.assignee_id', 'assignee.id')
            .where(function() {
                this.where('t.creator_id', userId)
                    .orWhere('t.assignee_id', userId);
            });

        if (status) {
            if (!validStatuses.includes(status as string)) {
                res.status(400).json({ error: `Статус должен быть одним из: ${validStatuses.join(', ')}.` });
                return;
            }
            query.andWhere('t.status', status as string);
        }

        if (startDate) {
            // Ensure startDate is a valid date format before using in query
            if (isNaN(new Date(startDate as string).getTime())) {
                res.status(400).json({ error: 'Неверный формат начальной даты.' });
                return;
            }
            query.andWhere('t.created_at', '>=', startDate as string);
        }

        if (endDate) {
            // Ensure endDate is a valid date format
            if (isNaN(new Date(endDate as string).getTime())) {
                res.status(400).json({ error: 'Неверный формат конечной даты.' });
                return;
            }
            query.andWhere('t.created_at', '<=', endDate as string);
        }

        const tasksData = await query.orderBy('t.created_at', 'desc');

        const tasks = tasksData.map(task => ({
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
        // Check for specific Knex/DB errors if necessary, e.g., invalid date format if not caught above
        res.status(500).json({ error: 'Не удалось сгенерировать отчет' });
    }
};