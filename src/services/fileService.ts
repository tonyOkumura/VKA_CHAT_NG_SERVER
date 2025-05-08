import { Request, Response } from 'express';
import fs from 'fs/promises';
import { constants as fsConstants, createReadStream as fsCreateReadStream } from 'fs'; // Import createReadStream from 'fs'
import path from 'path';
import multer from 'multer';
import knex from '../lib/knex';
import type { Knex as KnexType } from 'knex'; // Import Knex type
import { isUserParticipant } from '../lib/dbHelpers'; // Import helper

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
        // Subdirectories (avatars, messages, tasks) are created by setupDirectories initially
        // and ensured by storeUploadedFile on demand.
    } catch (error) {
        console.error(`Error ensuring base upload directory ${UPLOAD_BASE_DIR}:`, error);
    }
})();

export const fileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Multer saves to the root of UPLOAD_BASE_DIR.
        // The service's storeUploadedFile function then moves it to the appropriate subdirectory.
        cb(null, UPLOAD_BASE_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const filename = uniqueSuffix + path.extname(file.originalname);
        cb(null, filename);
    }
});

export const uploadMiddleware = multer({
    storage: fileStorage,
    limits: {
        fileSize: 10 * 1024 * 1024 * 5 // Limit avatars to 5MB for now? Messages/Tasks can be larger.
    },
    fileFilter: (req, file, cb) => {
        // Basic image filter for avatars, can be expanded
        if (file.fieldname === 'avatar') {
            if (file.mimetype.startsWith('image/')) {
                cb(null, true);
            } else {
                cb(new Error('Only image files are allowed for avatars!') as any, false); // Pass error to middleware handler
            }
        } else {
            // Allow any file type for other uploads (messages, tasks)
            cb(null, true);
        }
    }
});

export interface FileUploadResult {
    filePathInDb: string;    // Relative path to be stored in DB (e.g., 'messages/uniquename.ext')
    diskFileName: string;    // The unique name on disk (e.g., 'uniquename.ext')
    originalName: string;
    mimeType: string;
    size: number;
}

async function moveAndRecordFile(
    uploadedFile: Express.Multer.File,
    type: keyof typeof SUBDIRECTORIES
): Promise<FileUploadResult> {
    const subDir = SUBDIRECTORIES[type];
    if (!subDir) {
        // Clean up uploaded file if type is invalid
        await fs.unlink(uploadedFile.path).catch(e => console.error(`Failed to cleanup file after invalid type: ${uploadedFile.path}`, e));
        throw new Error(`Invalid file type specified for storage: ${type}`);
    }

    const targetDirectory = path.join(UPLOAD_BASE_DIR, subDir);
    await fs.mkdir(targetDirectory, { recursive: true });

    const sourcePath = uploadedFile.path;
    const diskFileName = uploadedFile.filename;
    const destinationPath = path.join(targetDirectory, diskFileName);
    const filePathInDb = path.join(subDir, diskFileName).replace(/\\\\/g, '/'); // Ensure forward slashes for DB/URL

    try {
        await fs.rename(sourcePath, destinationPath);
        console.log(`File moved from ${sourcePath} to ${destinationPath}`);
    } catch (error) {
        console.error(`Error moving file from ${sourcePath} to ${destinationPath}:`, error);
        await fs.unlink(sourcePath).catch(e => {
            if (e.code !== 'ENOENT') console.error(`Failed to cleanup file after move error: ${sourcePath}`, e)
        });
        throw error;
    }

    return {
        filePathInDb: filePathInDb,
        diskFileName: diskFileName,
        originalName: uploadedFile.originalname,
        mimeType: uploadedFile.mimetype,
        size: uploadedFile.size
    };
}

export async function storeUploadedFile(
    uploadedFile: Express.Multer.File,
    type: keyof typeof SUBDIRECTORIES
): Promise<FileUploadResult> {
    // This function now mainly acts as a public interface
    // Specific logic (like DB interaction for messages/tasks) happens in controllers
    return moveAndRecordFile(uploadedFile, type);
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

// Updated getMessageFileDetailsForDownload using Knex
export async function getMessageFileDetailsForDownload(
    fileId: string, // DB ID of the file record
    userId: string   // For authorization
): Promise<FileDownloadDetails | FileDownloadError> {
    try {
        // Fetch file info and conversation_id using Knex
        const fileRecord = await knex('files as f')
            .select('f.file_path', 'f.file_name', 'f.file_type', 'm.conversation_id')
            .join('messages as m', 'f.message_id', 'm.id')
            .where('f.id', fileId)
            .first();

        if (!fileRecord) {
            return { error: 'Файл не найден в базе данных', status: 404 };
        }

        const { file_path: dbFilePath, file_name: originalFileName, file_type: mimeType, conversation_id: conversationId } = fileRecord;

        // Authorization check using isUserParticipant helper
        const isParticipant = await isUserParticipant(userId, conversationId); // isUserParticipant now uses Knex
        if (!isParticipant) {
            return { error: 'Доступ к файлу запрещен', status: 403 };
        }

        let finalAbsolutePathOnDisk: string;
        // Check if path is absolute (legacy) or relative (new)
        if (dbFilePath && path.isAbsolute(dbFilePath)) {
            finalAbsolutePathOnDisk = dbFilePath;
        } else if (dbFilePath) {
            finalAbsolutePathOnDisk = path.join(UPLOAD_BASE_DIR, dbFilePath);
        } else {
            console.error(`File record ${fileId} has null or empty file_path.`);
            return { error: 'Путь к файлу отсутствует в записи', status: 500 };
        }

        // Check file existence on disk
        await fs.access(finalAbsolutePathOnDisk);

        return {
            absolutePathOnDisk: finalAbsolutePathOnDisk,
            fileNameToUser: originalFileName,
            mimeType: mimeType || 'application/octet-stream' // Default mime type
        };

    } catch (error: any) {
        console.error(`Error getting details for message file ${fileId} for user ${userId}:`, error);
        if (error.code === 'ENOENT') { // File not found on disk
            return { error: 'Файл не найден на сервере', status: 404 };
        } else if (error.code === '22P02') { // Invalid UUID format for fileId
            return { error: 'Неверный формат ID файла', status: 400 };
        }
        // Other errors (DB connection, etc.)
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
            // Don't throw error if file is already gone
        } else {
            console.error(`Error deleting file ${absolutePath} from disk:`, error);
            throw error; // Re-throw other errors
        }
    }
}

// --- Avatar Specific Functions ---

// Helper to get the old avatar path from DB
const getOldAvatarDbPath = async (userId: string, trx: KnexType.Transaction): Promise<string | null> => {
    const oldAvatar = await trx('user_avatars')
        .select('file_path')
        .where('user_id', userId)
        .first();
    return oldAvatar ? oldAvatar.file_path : null;
};

export async function storeAvatar(
    uploadedFile: Express.Multer.File,
    userId: string
): Promise<FileUploadResult> {
    let moveResult: FileUploadResult | null = null;
    let oldAvatarDbPath: string | null = null;
    const originalMulterPath = uploadedFile.path;

    try {
        await knex.transaction(async (trx) => {
            oldAvatarDbPath = await getOldAvatarDbPath(userId, trx);
            moveResult = await moveAndRecordFile(uploadedFile, 'avatars');
            
            await trx('user_avatars')
                .insert({
                    user_id: userId,
                    file_name: moveResult!.originalName,
                    file_path: moveResult!.filePathInDb,
                    file_type: moveResult!.mimeType,
                    file_size: moveResult!.size,
                })
                .onConflict('user_id')
                .merge();
        });

        if (!moveResult) {
            console.error("Critical: Transaction completed, but moveResult is unexpectedly null.");
            throw new Error("Transaction completed but file move result is missing.");
        }
        
        if (oldAvatarDbPath && moveResult && oldAvatarDbPath !== (moveResult as FileUploadResult).filePathInDb) {
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
        const potentialNewPath = moveResult ? path.join(UPLOAD_BASE_DIR, (moveResult as FileUploadResult).filePathInDb) : null;
        if (potentialNewPath) {
            await fs.unlink(potentialNewPath).catch(cleanupError => {
                if (cleanupError.code !== 'ENOENT') {
                    console.error(`Failed to cleanup new avatar file ${potentialNewPath} after error:`, cleanupError);
                }
            });
        } else {
            await fs.unlink(originalMulterPath).catch(cleanupError => {
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
        const avatar = await knex('user_avatars')
            .select('file_path')
            .where('user_id', userId)
            .first();
        return avatar ? avatar.file_path : null;
    } catch (error) {
        console.error(`Error fetching avatar path for user ${userId}:`, error);
        return null;
    }
}

// Takes Express Response object to stream the file
export async function streamAvatar(userId: string, res: Response): Promise<void> {
    try {
        const avatarDbPath = await getAvatarPath(userId);

        if (!avatarDbPath) {
            res.status(404).send('Avatar not found');
            return;
        }

        // Construct absolute path (assuming dbPath is relative like 'avatars/file.jpg')
        const absolutePath = path.join(UPLOAD_BASE_DIR, avatarDbPath);

        // Check existence and stream
        try {
            await fs.access(absolutePath, fsConstants.R_OK);
            const avatarInfo = await knex('user_avatars').select('file_type').where('user_id', userId).first();
            res.setHeader('Content-Type', avatarInfo?.file_type || 'application/octet-stream');
            const stream = fsCreateReadStream(absolutePath);
            stream.pipe(res);
            // Handle stream errors
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

    } catch (error: any) { // Catch DB errors from getAvatarPath etc.
        console.error(`Error preparing to stream avatar for user ${userId}:`, error);
        if (error.code === '22P02') { // Handle potential invalid UUID format if userId comes from params
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
            // 1. Get old path
            oldAvatarDbPath = await getOldAvatarDbPath(userId, trx);
            
            // 2. Delete DB record
            const deletedRows = await trx('user_avatars')
                .where('user_id', userId)
                .del();

            if (deletedRows === 0 && oldAvatarDbPath) {
                // DB record was gone but path was found? Log inconsistency.
                console.warn(`Avatar DB record for user ${userId} not found during delete, but path ${oldAvatarDbPath} was previously fetched.`);
                // Proceed to delete the file anyway if path exists.
            } else if (deletedRows === 0 && !oldAvatarDbPath) {
                // No record found, nothing to delete (file or DB).
                console.log(`Avatar for user ${userId} not found. Nothing deleted.`);
                // Optionally throw an error to indicate "Not Found" if required by controller.
                // For now, just exit transaction successfully.
                return;
            }
            // DB record deleted. File deletion happens after commit.
        });

        // 3. Delete file from disk AFTER successful transaction
        if (oldAvatarDbPath) {
            await deleteFileFromDiskByDbPath(oldAvatarDbPath);
            console.log(`Avatar file deleted successfully: ${oldAvatarDbPath}`);
        }

    } catch (error) {
        console.error(`Error deleting avatar for user ${userId}:`, error);
        // Do not attempt file cleanup here, as the DB operation failed.
        throw error; // Re-throw error for the controller to handle
    }
}

// --- End Avatar Specific Functions --- 