import { Request, Response } from 'express';
import pool from '../models/db';

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
        // Выбираем только нужные поля, исключая пароль, и переименовываем id в user_id
        const result = await pool.query(
            `SELECT id as user_id, username, email, is_online, created_at, updated_at 
             FROM users 
             ORDER BY username ASC`
        );

        console.log(`All users fetched successfully.`);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching all users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
}; 