import { Request, Response } from 'express';
import pool from '../models/db';

// Remove SERVER_BASE_URL and getAbsoluteUrl
// const HOST = process.env.HOST || 'localhost';
// const PORT = process.env.PORT || 6000;
// const SERVER_BASE_URL = `http://${HOST}:${PORT}`;

export const updateUserOnlineStatus = async (userId: string, isOnline: boolean): Promise<void> => {
    try {
        await pool.query(
            `
            UPDATE users 
            SET is_online = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            `,
            [isOnline, userId]
        );
        console.log(`Статус пользователя ${userId} обновлен на ${isOnline ? 'онлайн' : 'офлайн'}`);
    } catch (error) {
        console.error('Ошибка при обновлении статуса пользователя:', error);
        throw error;
    }
};

export const getAllUsers = async (req: Request, res: Response): Promise<any> => {
    console.log(`Fetching all users.`);

    try {
        const user_id = req.user?.id;
        if (!user_id) {
            console.error('No user ID found in request.');
            return res.status(401).json({ error: 'Unauthorized: User ID not found' });
        }

        // Выбираем поля пользователя и добавляем avatarUrl через LEFT JOIN, исключая текущего пользователя
        const result = await pool.query(
            `SELECT 
                u.id as user_id, 
                u.username, 
                u.email, 
                u.is_online, 
                u.created_at, 
                u.updated_at,
                ua.file_path AS "avatarPath" -- Get the relative path
             FROM users u
             LEFT JOIN user_avatars ua ON u.id = ua.user_id
             WHERE u.id != $1
             ORDER BY u.username ASC`,
            [user_id]
        );

        console.log(`All users fetched successfully, excluding user ID: ${user_id}.`);
        // Return the rows directly, avatarPath is already selected
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching all users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
};

export const getUserProfile = async (req: Request, res: Response): Promise<any> => {
    const { userId } = req.params;
    const currentUserId = req.user?.id;

    if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
    }

    try {
        // Получаем основную информацию о пользователе
        const userResult = await pool.query(
            `SELECT 
                u.id,
                u.username,
                u.email,
                u.is_online,
                u.created_at,
                u.updated_at,
                ua.file_path AS "avatarPath",
                ua.file_type AS "avatarType",
                ua.file_size AS "avatarSize",
                ua.created_at AS "avatarCreatedAt",
                ua.updated_at AS "avatarUpdatedAt"
            FROM users u
            LEFT JOIN user_avatars ua ON u.id = ua.user_id
            WHERE u.id = $1`,
            [userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];

        // Получаем количество контактов пользователя
        const contactsResult = await pool.query(
            `SELECT COUNT(*) as contact_count FROM contacts WHERE user_id = $1`,
            [userId]
        );
        user.contactCount = parseInt(contactsResult.rows[0].contact_count);

        // Получаем количество чатов пользователя
        const conversationsResult = await pool.query(
            `SELECT COUNT(*) as conversation_count FROM conversation_participants WHERE user_id = $1`,
            [userId]
        );
        user.conversationCount = parseInt(conversationsResult.rows[0].conversation_count);

        // Получаем статистику по задачам
        const tasksStatsResult = await pool.query(
            `SELECT 
                COUNT(*) FILTER (WHERE creator_id = $1) as created_tasks,
                COUNT(*) FILTER (WHERE assignee_id = $1) as assigned_tasks,
                COUNT(*) FILTER (WHERE assignee_id = $1 AND status = 'done') as completed_tasks
            FROM tasks`,
            [userId]
        );
        user.tasksStats = tasksStatsResult.rows[0];

        // Если запрашивает текущий пользователь, добавляем дополнительную информацию
        if (currentUserId === userId) {
            // Получаем список контактов
            const contactsListResult = await pool.query(
                `SELECT 
                    u.id,
                    u.username,
                    u.email,
                    u.is_online,
                    ua.file_path AS "avatarPath"
                FROM contacts c
                JOIN users u ON u.id = c.contact_id
                LEFT JOIN user_avatars ua ON u.id = ua.user_id
                WHERE c.user_id = $1
                ORDER BY u.username ASC`,
                [userId]
            );
            user.contacts = contactsListResult.rows;

            // Получаем список чатов
            const conversationsListResult = await pool.query(
                `SELECT 
                    c.id,
                    c.name,
                    c.is_group_chat,
                    c.avatar_path AS "groupAvatarPath",
                    cp.is_muted,
                    cp.last_read_timestamp
                FROM conversation_participants cp
                JOIN conversations c ON c.id = cp.conversation_id
                WHERE cp.user_id = $1
                ORDER BY c.name ASC`,
                [userId]
            );
            user.conversations = conversationsListResult.rows;
        }

        // Форматируем даты в ISO строки
        user.created_at = new Date(user.created_at).toISOString();
        user.updated_at = new Date(user.updated_at).toISOString();
        if (user.avatarCreatedAt) {
            user.avatarCreatedAt = new Date(user.avatarCreatedAt).toISOString();
            user.avatarUpdatedAt = new Date(user.avatarUpdatedAt).toISOString();
        }

        res.json(user);
    } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).json({ error: 'Failed to fetch user profile' });
    }
};

export const getCurrentUserProfile = async (req: Request, res: Response): Promise<any> => {
    const currentUserId = req.user?.id;

    if (!currentUserId) {
        return res.status(401).json({ error: 'Unauthorized: User ID not found in token' });
    }

    try {
        // Получаем основную информацию о пользователе
        const userResult = await pool.query(
            `SELECT 
                u.id,
                u.username,
                u.email,
                u.is_online,
                u.created_at,
                u.updated_at,
                ua.file_path AS "avatarPath",
                ua.file_type AS "avatarType",
                ua.file_size AS "avatarSize",
                ua.created_at AS "avatarCreatedAt",
                ua.updated_at AS "avatarUpdatedAt"
            FROM users u
            LEFT JOIN user_avatars ua ON u.id = ua.user_id
            WHERE u.id = $1`,
            [currentUserId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];

        // Получаем количество контактов пользователя
        const contactsResult = await pool.query(
            `SELECT COUNT(*) as contact_count FROM contacts WHERE user_id = $1`,
            [currentUserId]
        );
        user.contactCount = parseInt(contactsResult.rows[0].contact_count);

        // Получаем количество чатов пользователя
        const conversationsResult = await pool.query(
            `SELECT COUNT(*) as conversation_count FROM conversation_participants WHERE user_id = $1`,
            [currentUserId]
        );
        user.conversationCount = parseInt(conversationsResult.rows[0].conversation_count);

        // Получаем статистику по задачам
        const tasksStatsResult = await pool.query(
            `SELECT 
                COUNT(*) FILTER (WHERE creator_id = $1) as created_tasks,
                COUNT(*) FILTER (WHERE assignee_id = $1) as assigned_tasks,
                COUNT(*) FILTER (WHERE assignee_id = $1 AND status = 'done') as completed_tasks
            FROM tasks`,
            [currentUserId]
        );
        user.tasksStats = tasksStatsResult.rows[0];

        // Получаем список контактов
        const contactsListResult = await pool.query(
            `SELECT 
                u.id,
                u.username,
                u.email,
                u.is_online,
                ua.file_path AS "avatarPath"
            FROM contacts c
            JOIN users u ON u.id = c.contact_id
            LEFT JOIN user_avatars ua ON u.id = ua.user_id
            WHERE c.user_id = $1
            ORDER BY u.username ASC`,
            [currentUserId]
        );
        user.contacts = contactsListResult.rows;

        // Получаем список чатов
        const conversationsListResult = await pool.query(
            `SELECT 
                c.id,
                c.name,
                c.is_group_chat,
                c.avatar_path AS "groupAvatarPath",
                cp.is_muted,
                cp.last_read_timestamp
            FROM conversation_participants cp
            JOIN conversations c ON c.id = cp.conversation_id
            WHERE cp.user_id = $1
            ORDER BY c.name ASC`,
            [currentUserId]
        );
        user.conversations = conversationsListResult.rows;

        // Получаем список активных задач
        const activeTasksResult = await pool.query(
            `SELECT 
                t.id,
                t.title,
                t.status,
                t.priority,
                t.due_date,
                t.created_at,
                t.updated_at,
                creator.username as creator_username,
                creator_avatar.file_path as "creatorAvatarPath",
                assignee.username as assignee_username,
                assignee_avatar.file_path as "assigneeAvatarPath"
            FROM tasks t
            LEFT JOIN users creator ON t.creator_id = creator.id
            LEFT JOIN users assignee ON t.assignee_id = assignee.id
            LEFT JOIN user_avatars creator_avatar ON creator.id = creator_avatar.user_id
            LEFT JOIN user_avatars assignee_avatar ON assignee.id = assignee_avatar.user_id
            WHERE t.creator_id = $1 OR t.assignee_id = $1
            ORDER BY t.updated_at DESC
            LIMIT 5`,
            [currentUserId]
        );
        user.activeTasks = activeTasksResult.rows.map(task => ({
            ...task,
            created_at: new Date(task.created_at).toISOString(),
            updated_at: new Date(task.updated_at).toISOString(),
            due_date: task.due_date ? new Date(task.due_date).toISOString() : null
        }));

        // Форматируем даты в ISO строки
        user.created_at = new Date(user.created_at).toISOString();
        user.updated_at = new Date(user.updated_at).toISOString();
        if (user.avatarCreatedAt) {
            user.avatarCreatedAt = new Date(user.avatarCreatedAt).toISOString();
            user.avatarUpdatedAt = new Date(user.avatarUpdatedAt).toISOString();
        }

        res.json(user);
    } catch (error) {
        console.error('Error fetching current user profile:', error);
        res.status(500).json({ error: 'Failed to fetch user profile' });
    }
};