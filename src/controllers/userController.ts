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