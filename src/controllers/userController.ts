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