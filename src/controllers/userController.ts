import { Request, Response } from 'express';
import knex from '../lib/knex';
import * as fileService from '../services/fileService';

export const updateUserOnlineStatus = async (userId: string, isOnline: boolean): Promise<void> => {
    try {
        await knex('users')
            .where('id', userId)
            .update({
                is_online: isOnline,
                updated_at: knex.fn.now()
            });
        console.log(`Статус пользователя ${userId} обновлен на ${isOnline ? 'онлайн' : 'офлайн'}`);
    } catch (error) {
        console.error('Ошибка при обновлении статуса пользователя:', error);
    }
};

export const getAllUsers = async (req: Request, res: Response): Promise<any> => {
    console.log(`Fetching all users.`);

    try {
        const users = await knex('users as u')
            .select(
                'u.id as user_id',
                'u.username',
                'u.email',
                'u.is_online',
                'u.created_at',
                'u.updated_at',
                knex.raw("(SELECT file_path FROM user_avatars WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) as avatar_path")
            )
            .orderBy('u.username', 'asc');

        console.log(`All users fetched successfully.`);
        
        const formattedUsers = users.map(user => ({
            ...user,
            avatarPath: user.avatar_path,
            created_at: user.created_at ? new Date(user.created_at).toISOString() : null,
            updated_at: user.updated_at ? new Date(user.updated_at).toISOString() : null,
        }));

        res.json(formattedUsers);
    } catch (error) {
        console.error('Error fetching all users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
};

export const uploadUserAvatar = async (req: Request, res: Response): Promise<any> => {
    const userId = req.user?.id;
    const targetUserId = req.params.userId;

    if (!userId) {
        return res.status(401).json({ error: "Не авторизован" });
    }
    if (userId !== targetUserId) {
        return res.status(403).json({ error: "Попытка загрузить аватар для другого пользователя" });
    }
    if (!req.file) {
        return res.status(400).json({ error: "Файл не найден" });
    }

    try {
        const { filePathInDb, originalName } = await fileService.storeAvatar(req.file, userId);
        
        res.status(201).json({
            message: "Аватар успешно загружен",
            filePath: filePathInDb,
            fileName: originalName,
            downloadUrl: `/api/users/${userId}/avatar`
        });
    } catch (error) {
        console.error("Ошибка при загрузке аватара:", error);
        res.status(500).json({ error: "Не удалось загрузить аватар" });
    }
};

export const streamUserAvatar = async (req: Request, res: Response): Promise<any> => {
    const { userId } = req.params;
    try {
        await fileService.streamAvatar(userId, res);
    } catch (error: any) {
        console.error(`Ошибка при стриминге аватара для пользователя ${userId}:`, error);
        if (!res.headersSent) {
            if (error.message && (error.message.includes('not found') || error.message.includes('missing'))) {
                return res.status(404).json({ error: error.message });
            }
            res.status(500).json({ error: "Не удалось получить аватар" });
        }
    }
};

export const deleteUserAvatar = async (req: Request, res: Response): Promise<any> => {
    const userId = req.user?.id;
    const targetUserId = req.params.userId;

    if (!userId) {
        return res.status(401).json({ error: "Не авторизован" });
    }
    if (userId !== targetUserId) {
        return res.status(403).json({ error: "Попытка удалить аватар другого пользователя" });
    }

    try {
        await fileService.deleteAvatar(userId);
        res.status(200).json({ message: "Аватар успешно удален" });
    } catch (error: any) {
        console.error(`Ошибка при удалении аватара для пользователя ${userId}:`, error);
        if (error.message && error.message.toLowerCase().includes('not found')) {
            return res.status(404).json({ error: "Аватар не найден или уже удален" });
        }
        res.status(500).json({ error: "Не удалось удалить аватар" });
    }
}; 