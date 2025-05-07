import fs from 'fs';
import path from 'path';

export function setupDirectories(): void {
    const uploadsDir = path.join(__dirname, '..', 'Uploads');
    const directories = [
        uploadsDir,
        path.join(uploadsDir, 'avatars'),
        path.join(uploadsDir, 'messages'),
        path.join(uploadsDir, 'tasks'),
    ];

    directories.forEach((dir) => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`Created directory: ${dir}`);
        }
    });
}