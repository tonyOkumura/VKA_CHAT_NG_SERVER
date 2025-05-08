import { Request, Response } from 'express';
import fs from 'fs/promises';
import { constants as fsConstants, createReadStream as fsCreateReadStream } from 'fs';
import path from 'path';
import multer from 'multer';
import knex from '../lib/knex';
import type { Knex as KnexType } from 'knex';
import { isUserDialogParticipant, isUserGroupParticipant } from '../lib/dbHelpers';
import { isUserTaskParticipant } from '../controllers/taskController';

export const UPLOAD_BASE_DIR = path.join(process.cwd(), 'uploads');

const SUBDIRECTORIES = {
    avatars: 'avatars',
    messages: 'messages',
    tasks: 'tasks',
};

// Ensure base upload directory exists on service load
(async () => {
    try {
        await fs.mkdir(UPLOAD_BASE_DIR, { recursive: true });
        console.log(`Base upload directory ${UPLOAD_BASE_DIR} ensured.`);
    } catch (error) {
        console.error(`Error ensuring base upload directory ${UPLOAD_BASE_DIR}:`, error);
    }
})();

export const fileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_BASE_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const filename = uniqueSuffix + path.extname(file.originalname);
        cb(null, filename);
    },
});

export const uploadMiddleware = multer({
    storage: fileStorage,
    limits: {
        fileSize: 10 * 1024 * 1024 * 1024, // 10GB for messages/tasks
    },
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'avatar') {
            if (file.mimetype.startsWith('image/')) {
                cb(null, true);
            } else {
                cb(new Error('Only image files are allowed for avatars!') as any, false);
            }
        } else {
            cb(null, true);
        }
    },
});

export interface FileUploadResult {
    filePathInDb: string;
    diskFileName: string;
    originalName: string;
    mimeType: string;
    size: number;
}

export interface FileDownloadDetails {
    absolutePathOnDisk: string;
    fileNameToUser: string;
    mimeType: string;
}

export interface FileDownloadError {
    error: string;
    status: number;
}

async function moveAndRecordFile(
    uploadedFile: Express.Multer.File,
    type: keyof typeof SUBDIRECTORIES
): Promise<FileUploadResult> {
    const subDir = SUBDIRECTORIES[type];
    if (!subDir) {
        await fs.unlink(uploadedFile.path).catch((e) =>
            console.error(`Failed to cleanup file after invalid type: ${uploadedFile.path}`, e)
        );
        throw new Error(`Invalid file type specified for storage: ${type}`);
    }

    const targetDirectory = path.join(UPLOAD_BASE_DIR, subDir);
    await fs.mkdir(targetDirectory, { recursive: true });

    const sourcePath = uploadedFile.path;
    const diskFileName = uploadedFile.filename;
    const destinationPath = path.join(targetDirectory, diskFileName);
    const filePathInDb = path.join(subDir, diskFileName).replace(/\\\\/g, '/');

    try {
        await fs.rename(sourcePath, destinationPath);
        console.log(`File moved from ${sourcePath} to ${destinationPath}`);
    } catch (error) {
        console.error(`Error moving file from ${sourcePath} to ${destinationPath}:`, error);
        await fs.unlink(sourcePath).catch((e) => {
            if (e.code !== 'ENOENT')
                console.error(`Failed to cleanup file after move error: ${sourcePath}`, e);
        });
        throw error;
    }

    return {
        filePathInDb,
        diskFileName,
        originalName: uploadedFile.originalname,
        mimeType: uploadedFile.mimetype,
        size: uploadedFile.size,
    };
}

export async function storeUploadedFile(
    uploadedFile: Express.Multer.File,
    type: keyof typeof SUBDIRECTORIES
): Promise<FileUploadResult> {
    return moveAndRecordFile(uploadedFile, type);
}

export async function getMessageFileDetailsForDownload(
    fileId: string,
    userId: string
): Promise<FileDownloadDetails | FileDownloadError> {
    try {
        const fileRecord = await knex('files as f')
            .select('f.file_path', 'f.file_name', 'f.file_type', 'm.dialog_id', 'm.group_id')
            .join('messages as m', 'f.message_id', 'm.id')
            .where('f.id', fileId)
            .first();

        if (!fileRecord) {
            return { error: 'Файл не найден в базе данных', status: 404 };
        }

        const { file_path: dbFilePath, file_name: originalFileName, file_type: mimeType, dialog_id, group_id } = fileRecord;

        if (!dialog_id && !group_id) {
            return { error: 'Сообщение не связано ни с диалогом, ни с группой', status: 500 };
        }

        const isParticipant = dialog_id
            ? await isUserDialogParticipant(userId, dialog_id)
            : await isUserGroupParticipant(userId, group_id!);
        if (!isParticipant) {
            return { error: 'Доступ к файлу запрещен', status: 403 };
        }

        let finalAbsolutePathOnDisk: string;
        if (dbFilePath && path.isAbsolute(dbFilePath)) {
            finalAbsolutePathOnDisk = dbFilePath;
        } else if (dbFilePath) {
            finalAbsolutePathOnDisk = path.join(UPLOAD_BASE_DIR, dbFilePath);
        } else {
            console.error(`File record ${fileId} has null or empty file_path.`);
            return { error: 'Путь к файлу отсутствует в записи', status: 500 };
        }

        await fs.access(finalAbsolutePathOnDisk);

        return {
            absolutePathOnDisk: finalAbsolutePathOnDisk,
            fileNameToUser: originalFileName,
            mimeType: mimeType || 'application/octet-stream',
        };
    } catch (error: any) {
        console.error(`Error getting details for message file ${fileId} for user ${userId}:`, error);
        if (error.code === 'ENOENT') {
            return { error: 'Файл не найден на сервере', status: 404 };
        } else if (error.code === '22P02') {
            return { error: 'Неверный формат ID файла', status: 400 };
        }
        return { error: 'Ошибка при получении информации о файле', status: 500 };
    }
}

export async function getTaskFileDetailsForDownload(
    attachmentId: string,
    userId: string
): Promise<FileDownloadDetails | FileDownloadError> {
    try {
        const attachment = await knex('task_attachments as ta')
            .select('ta.file_path', 'ta.file_name', 'ta.file_type', 'ta.task_id')
            .where('ta.id', attachmentId)
            .first();

        if (!attachment) {
            return { error: 'Вложение не найдено в базе данных', status: 404 };
        }

        const { file_path: dbFilePath, file_name: originalFileName, file_type: mimeType, task_id } = attachment;

        const isParticipant = await isUserTaskParticipant(userId, task_id);
        if (!isParticipant) {
            return { error: 'Доступ к файлу запрещен', status: 403 };
        }

        let finalAbsolutePathOnDisk: string;
        if (dbFilePath && path.isAbsolute(dbFilePath)) {
            finalAbsolutePathOnDisk = dbFilePath;
        } else if (dbFilePath) {
            finalAbsolutePathOnDisk = path.join(UPLOAD_BASE_DIR, dbFilePath);
        } else {
            console.error(`Attachment record ${attachmentId} has null or empty file_path.`);
            return { error: 'Путь к файлу отсутствует в записи', status: 500 };
        }

        await fs.access(finalAbsolutePathOnDisk);

        return {
            absolutePathOnDisk: finalAbsolutePathOnDisk,
            fileNameToUser: originalFileName,
            mimeType: mimeType || 'application/octet-stream',
        };
    } catch (error: any) {
        console.error(`Error getting details for task attachment ${attachmentId} for user ${userId}:`, error);
        if (error.code === 'ENOENT') {
            return { error: 'Файл не найден на сервере', status: 404 };
        } else if (error.code === '22P02') {
            return { error: 'Неверный формат ID вложения', status: 400 };
        }
        return { error: 'Ошибка при получении информации о файле', status: 500 };
    }
}

export async function deleteFileFromDiskByDbPath(dbFilePath: string): Promise<void> {
    let absolutePath: string;
    if (path.isAbsolute(dbFilePath)) {
        absolutePath = dbFilePath;
    } else {
        absolutePath = path.join(UPLOAD_BASE_DIR, dbFilePath);
    }

    try {
        await fs.unlink(absolutePath);
        console.log(`File deleted from disk: ${absolutePath}`);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            console.warn(`File not found for deletion (already deleted?): ${absolutePath}`);
        } else {
            console.error(`Error deleting file ${absolutePath} from disk:`, error);
            throw error;
        }
    }
}

export async function storeAvatar(
    uploadedFile: Express.Multer.File,
    userId: string
): Promise<FileUploadResult> {
    let moveResult: FileUploadResult | null = null;
    let oldAvatarDbPath: string | null = null;
    const originalMulterPath = uploadedFile.path;

    try {
        moveResult = await knex.transaction(async (trx) => {
            const user = await trx('users')
                .select('avatar_path')
                .where('id', userId)
                .first();
            oldAvatarDbPath = user?.avatar_path || null;

            const result = await moveAndRecordFile(uploadedFile, 'avatars');

            await trx('users')
                .where('id', userId)
                .update({
                    avatar_path: result.filePathInDb,
                });

            return result;
        });

        if (oldAvatarDbPath && oldAvatarDbPath !== moveResult.filePathInDb) {
            try {
                await deleteFileFromDiskByDbPath(oldAvatarDbPath);
                console.log(`Successfully deleted old avatar file: ${oldAvatarDbPath}`);
            } catch (deleteError) {
                console.error(`Failed to delete old avatar file ${oldAvatarDbPath} after saving new one:`, deleteError);
            }
        }

        return moveResult;
    } catch (error) {
        console.error(`Error storing avatar for user ${userId}:`, error);
        const potentialNewPath = moveResult ? path.join(UPLOAD_BASE_DIR, moveResult.filePathInDb) : null;
        if (potentialNewPath) {
            await fs.unlink(potentialNewPath).catch((cleanupError) => {
                if (cleanupError.code !== 'ENOENT') {
                    console.error(`Failed to cleanup new avatar file ${potentialNewPath} after error:`, cleanupError);
                }
            });
        } else {
            await fs.unlink(originalMulterPath).catch((cleanupError) => {
                if (cleanupError.code !== 'ENOENT') {
                    console.error(`Failed cleanup original upload file ${originalMulterPath} after error:`, cleanupError);
                }
            });
        }
        throw error;
    }
}

export async function getAvatarPath(userId: string): Promise<string | null> {
    try {
        const user = await knex('users')
            .select('avatar_path')
            .where('id', userId)
            .first();
        return user?.avatar_path || null;
    } catch (error) {
        console.error(`Error fetching avatar path for user ${userId}:`, error);
        return null;
    }
}

export async function streamAvatar(userId: string, res: Response): Promise<void> {
    try {
        const avatarDbPath = await getAvatarPath(userId);

        if (!avatarDbPath) {
            res.status(404).send('Avatar not found');
            return;
        }

        const absolutePath = path.join(UPLOAD_BASE_DIR, avatarDbPath);

        try {
            await fs.access(absolutePath, fsConstants.R_OK);
            const user = await knex('users').select('avatar_path').where('id', userId).first();
            res.setHeader('Content-Type', 'image/jpeg'); // Default to JPEG, adjust if needed
            const stream = fsCreateReadStream(absolutePath);
            stream.pipe(res);
            stream.on('error', (err: NodeJS.ErrnoException) => {
                console.error(`Error streaming avatar ${absolutePath}:`, err);
                if (!res.headersSent) {
                    res.status(500).send('Failed to stream avatar');
                }
            });
        } catch (accessError: any) {
            if (accessError.code === 'ENOENT') {
                console.error(`Avatar file not found on disk: ${absolutePath} (User ID: ${userId})`);
                res.status(404).send('Avatar file missing on server');
            } else {
                console.error(`Avatar file not accessible: ${absolutePath} (User ID: ${userId})`, accessError);
                res.status(500).send('Failed to access avatar file');
            }
        }
    } catch (error: any) {
        console.error(`Error preparing to stream avatar for user ${userId}:`, error);
        if (error.code === '22P02') {
            res.status(400).send('Invalid User ID format');
        } else if (!res.headersSent) {
            res.status(500).send('Failed to stream avatar');
        }
    }
}

export async function deleteAvatar(userId: string): Promise<void> {
    let oldAvatarDbPath: string | null = null;
    try {
        await knex.transaction(async (trx) => {
            const user = await trx('users')
                .select('avatar_path')
                .where('id', userId)
                .first();
            oldAvatarDbPath = user?.avatar_path || null;

            if (!oldAvatarDbPath) {
                console.log(`Avatar for user ${userId} not found. Nothing deleted.`);
                return;
            }

            await trx('users')
                .where('id', userId)
                .update({
                    avatar_path: null,
                });
        });

        if (oldAvatarDbPath) {
            await deleteFileFromDiskByDbPath(oldAvatarDbPath);
            console.log(`Avatar file deleted successfully: ${oldAvatarDbPath}`);
        }
    } catch (error) {
        console.error(`Error deleting avatar for user ${userId}:`, error);
        throw error;
    }
}