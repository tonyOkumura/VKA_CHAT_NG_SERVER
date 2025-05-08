import { Request, Response } from 'express';
import knex from '../lib/knex';
import * as fileService from '../services/fileService';

// Интерфейс для пользователя в ответе getAllUsers
interface UserResponse {
    user_id: string;
    username: string;
    email: string;
    is_online: boolean;
    avatarPath: string | null;
    created_at: string | null;
    updated_at: string | null;
}

// Интерфейс для ответа при загрузке аватара
interface AvatarUploadResponse {
    message: string;
    filePath: string;
    fileName: string;
    downloadUrl: string;
}

export const updateUserOnlineStatus = async (userId: string, isOnline: boolean): Promise<void> => {
    try {
        await knex('users')
            .where('id', userId)
            .update({
                is_online: isOnline,
                updated_at: knex.fn.now(),
            });
        console.log(`Статус пользователя ${userId} обновлен на ${isOnline ? 'онлайн' : 'офлайн'}`);
    } catch (error: any) {
        console.error(`Ошибка при обновлении статуса пользователя ${userId}:`, {
            errorCode: error.code,
            errorMessage: error.message,
        });
        throw error; // Позволяет вызывающей стороне обработать ошибку
    }
};

export const getAllUsers = async (req: Request, res: Response): Promise<void> => {
    console.log(`Получение списка всех пользователей для пользователя ${req.user?.id}`);

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

        console.log(`Успешно получено ${users.length} пользователей`);

        const formattedUsers: UserResponse[] = users.map(user => ({
            user_id: user.user_id,
            username: user.username,
            email: user.email,
            is_online: user.is_online,
            avatarPath: user.avatar_path,
            created_at: user.created_at ? new Date(user.created_at).toISOString() : null,
            updated_at: user.updated_at ? new Date(user.updated_at).toISOString() : null,
        }));

        res.json(formattedUsers);
    } catch (error: any) {
        console.error('Ошибка при получении списка пользователей:', {
            errorCode: error.code,
            errorMessage: error.message,
        });
        res.status(500).json({ error: 'Не удалось получить список пользователей' });
    }
};

export const uploadUserAvatar = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const targetUserId = req.params.userId;

    if (!userId) {
        res.status(401).json({ error: 'Не авторизован' });
        return;
    }
    if (userId !== targetUserId) {
        res.status(403).json({ error: 'Попытка загрузить аватар для другого пользователя' });
        return;
    }
    if (!req.file) {
        res.status(400).json({ error: 'Файл не найден' });
        return;
    }

    try {
        const { filePathInDb, originalName } = await fileService.storeAvatar(req.file, userId);

        const response: AvatarUploadResponse = {
            message: 'Аватар успешно загружен',
            filePath: filePathInDb,
            fileName: originalName,
            downloadUrl: `/api/users/${userId}/avatar`,
        };

        res.status(201).json(response);
        console.log(`Аватар успешно загружен для пользователя ${userId}: ${filePathInDb}`);
    } catch (error: any) {
        console.error(`Ошибка при загрузке аватара для пользователя ${userId}:`, {
            errorCode: error.code,
            errorMessage: error.message,
        });
        res.status(500).json({ error: 'Не удалось загрузить аватар' });
    }
};

export const streamUserAvatar = async (req: Request, res: Response): Promise<void> => {
    const { userId } = req.params;

    try {
        await fileService.streamAvatar(userId, res);
    } catch (error: any) {
        console.error(`Ошибка при стриминге аватара для пользователя ${userId}:`, {
            errorCode: error.code,
            errorMessage: error.message,
        });
        if (!res.headersSent) {
            if (error.code === 'ENOENT' || (error.message && error.message.includes('not found'))) {
                res.status(404).json({ error: 'Аватар не найден на сервере' });
            } else {
                res.status(500).json({ error: 'Не удалось получить аватар' });
            }
        }
    }
};

export const deleteUserAvatar = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const targetUserId = req.params.userId;

    if (!userId) {
        res.status(401).json({ error: 'Не авторизован' });
        return;
    }
    if (userId !== targetUserId) {
        res.status(403).json({ error: 'Попытка удалить аватар другого пользователя' });
        return;
    }

    try {
        await fileService.deleteAvatar(userId);
        res.status(200).json({ message: 'Аватар успешно удален' });
        console.log(`Аватар успешно удален для пользователя ${userId}`);
    } catch (error: any) {
        console.error(`Ошибка при удалении аватара для пользователя ${userId}:`, {
            errorCode: error.code,
            errorMessage: error.message,
        });
        if (error.code === 'ENOENT' || (error.message && error.message.toLowerCase().includes('not found'))) {
            res.status(404).json({ error: 'Аватар не найден или уже удален' });
        } else {
            res.status(500).json({ error: 'Не удалось удалить аватар' });
        }
    }
};