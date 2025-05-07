import { Request, Response } from 'express';
import pool from '../models/db';
import fs from 'fs';
import path from 'path';

// Extend Express Request type to include user property from verifyToken
// interface AuthenticatedRequest extends Request {
//     user?: { id: string }; // Assuming verifyToken adds user with id
//     file?: Express.Multer.File; // Multer already adds this to Request
// }
// No longer needed due to declaration merging in src/types/express/index.d.ts

const AVATARS_BASE_URL = '/uploads/avatars/'; 

// --- Helper Function --- Find and Delete Old Avatar File ---
const findAndDeleteOldAvatar = async (userId: string): Promise<void> => {
    try {
        const oldAvatarResult = await pool.query(
            'SELECT file_path FROM user_avatars WHERE user_id = $1',
            [userId]
        );
        if (oldAvatarResult.rows.length > 0) {
            const oldFilePathRelative = oldAvatarResult.rows[0].file_path;
            // Construct the absolute path based on the stored relative path
            // ASSUMING file_path is stored like 'avatar-userid-timestamp.jpg'
            const oldFilePathAbsolute = path.join(__dirname, '..', '..', 'uploads', 'avatars', path.basename(oldFilePathRelative));
            // Check if file exists before attempting deletion
            if (fs.existsSync(oldFilePathAbsolute)) {
                fs.unlink(oldFilePathAbsolute, (err) => {
                    if (err) {
                        console.error(`Error deleting old avatar file ${oldFilePathAbsolute}:`, err);
                        // Don't throw, just log the error
                    } else {
                        console.log(`Old avatar file ${oldFilePathAbsolute} deleted successfully.`);
                    }
                });
            } else {
                console.warn(`Old avatar file not found at ${oldFilePathAbsolute}, skipping deletion.`);
            }
        }
    } catch (error) {
        console.error(`Error finding/deleting old avatar for user ${userId}:`, error);
        // Don't throw, just log the error
    }
};

export const uploadAvatar = async (req: Request, res: Response): Promise<any> => {
    // Check user from the augmented Request type
    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'Unauthorized: User ID not found in token' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'No avatar file uploaded.' });
    }

    const userId = req.user.id;
    const { filename } = req.file;
    const relativePath = `${AVATARS_BASE_URL}${filename}`; // Store relative path in DB

    console.log(`Attempting to upload/update avatar for user ${userId}: ${filename}`);

    try {
        // Before inserting/updating, delete the old avatar file from the filesystem
        await findAndDeleteOldAvatar(userId);

        // Use INSERT ON CONFLICT (user_id) DO UPDATE to handle both new uploads and updates
        const result = await pool.query(
            `
            INSERT INTO user_avatars (user_id, file_name, file_path, file_type, file_size, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id) DO UPDATE
            SET file_name = EXCLUDED.file_name,
                file_path = EXCLUDED.file_path,
                file_type = EXCLUDED.file_type,
                file_size = EXCLUDED.file_size,
                updated_at = CURRENT_TIMESTAMP
            RETURNING file_path; -- Still returns relative path from DB
            `,
            [userId, req.file.originalname, relativePath, req.file.mimetype, req.file.size]
        );

        console.log(`Avatar for user ${userId} saved/updated successfully. Path: ${relativePath}`);
        // uploadAvatar still returns RELATIVE path
        res.status(201).json({ message: 'Avatar uploaded successfully', avatarPath: relativePath });
    } catch (error: any) {
        console.error('Error uploading avatar:', error);
        // If DB operation fails, try to delete the newly uploaded file to prevent orphans
        const uploadedFilePath = path.join(__dirname, '..', '..', 'uploads', 'avatars', filename);
        if (fs.existsSync(uploadedFilePath)) {
            fs.unlink(uploadedFilePath, (unlinkErr) => {
                if (unlinkErr) console.error(`Error deleting orphaned upload ${uploadedFilePath}:`, unlinkErr);
            });
        }
        res.status(500).json({ error: 'Failed to upload avatar', details: error.message });
    }
};

export const getAvatar = async (req: Request, res: Response): Promise<any> => {
    const { userId } = req.params;
    if (!userId) {
        return res.status(400).json({ error: 'User ID parameter is required.' });
    }

    try {
        const result = await pool.query(
            'SELECT file_path FROM user_avatars WHERE user_id = $1',
            [userId]
        );

        if (result.rows.length === 0 || !result.rows[0].file_path) {
            // Return null path as requested
            return res.status(404).json({ error: 'Avatar not found for this user.', avatarPath: null });
        }

        const relativePath = result.rows[0].file_path;
        // Construct the absolute URL again for this specific endpoint - REMOVED
        // const absoluteUrl = `${SERVER_BASE_URL}${relativePath}`;
        // Return the relative path in the avatarPath field
        res.json({ avatarPath: relativePath });
    } catch (error) {
        console.error('Error fetching avatar:', error);
        res.status(500).json({ error: 'Failed to fetch avatar' });
    }
};

export const deleteAvatar = async (req: Request, res: Response): Promise<any> => {
    // Check user from the augmented Request type
    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'Unauthorized: User ID not found in token' });
    }
    const userId = req.user.id;
    console.log(`Attempting to delete avatar for user ${userId}`);

    try {
        // First, find the avatar record to get the file path
        const avatarResult = await pool.query(
            'SELECT file_path FROM user_avatars WHERE user_id = $1',
            [userId]
        );

        if (avatarResult.rows.length === 0) {
            return res.status(404).json({ error: 'Avatar not found. Nothing to delete.' });
        }

        const filePathRelative = avatarResult.rows[0].file_path;

        // Delete the database record
        const deleteResult = await pool.query(
            'DELETE FROM user_avatars WHERE user_id = $1 RETURNING user_id',
            [userId]
        );

        if (deleteResult.rowCount === 0) {
            // Should not happen if the previous query found a row, but good practice to check
            console.warn(`Avatar record for user ${userId} already deleted?`);
            return res.status(404).json({ error: 'Avatar not found during deletion.' });
        }

        // If DB deletion was successful, delete the file
        // Construct the absolute path based on the stored relative path
        const filePathAbsolute = path.join(__dirname, '..', '..', 'uploads', 'avatars', path.basename(filePathRelative));

        fs.unlink(filePathAbsolute, (err) => {
            if (err) {
                // Log error but still return success as DB record is deleted
                console.error(`Error deleting avatar file ${filePathAbsolute}:`, err);
                res.status(200).json({ message: 'Avatar database record deleted, but file deletion failed.', warning: err.message });
            } else {
                console.log(`Avatar file ${filePathAbsolute} deleted successfully.`);
                res.status(200).json({ message: 'Avatar deleted successfully' });
            }
        });

    } catch (error: any) {
        console.error('Error deleting avatar:', error);
        res.status(500).json({ error: 'Failed to delete avatar', details: error.message });
    }
};

export const streamAvatar = async (req: Request, res: Response): Promise<any> => {
    const { userId } = req.params;
    if (!userId) {
        return res.status(400).json({ error: 'User ID parameter is required.' });
    }

    try {
        const result = await pool.query(
            'SELECT file_path, file_type FROM user_avatars WHERE user_id = $1',
            [userId]
        );

        if (result.rows.length === 0 || !result.rows[0].file_path) {
            // Optionally send a default avatar image instead of 404
            // const defaultAvatarPath = path.join(__dirname, '..', '..', 'path_to_default_avatar.png');
            // if (fs.existsSync(defaultAvatarPath)) {
            //     res.setHeader('Content-Type', 'image/png');
            //     return fs.createReadStream(defaultAvatarPath).pipe(res);
            // }
            return res.status(404).send('Avatar not found');
        }

        const { file_path: filePathRelative, file_type: fileType } = result.rows[0];

        // Construct absolute path based on stored relative path
        // ASSUMING file_path is stored like '/uploads/avatars/avatar-userid-timestamp.jpg'
        const filePathAbsolute = path.join(__dirname, '..', '..', path.dirname(filePathRelative), path.basename(filePathRelative));
        // More robustly:
        // const filePathAbsolute = path.resolve(uploadsDir, 'avatars', path.basename(filePathRelative));

        if (fs.existsSync(filePathAbsolute)) {
            // Set content type
            if (fileType) {
                res.setHeader('Content-Type', fileType);
            } else {
                // Fallback if file_type wasn't stored (optional)
                res.setHeader('Content-Type', 'image/jpeg'); // Or derive from extension
            }
            // Stream the file
            fs.createReadStream(filePathAbsolute).pipe(res);
        } else {
            console.error(`Avatar file not found on disk for user ${userId} at path: ${filePathAbsolute} (DB entry exists)`);
            return res.status(404).send('Avatar file not found on server');
        }

    } catch (error) {
        console.error('Error streaming avatar:', error);
        res.status(500).send('Failed to stream avatar');
    }
}; 