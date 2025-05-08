import fs from 'fs';
import path from 'path';

export function setupDirectories(): void {
    const baseUploadsDir = path.join(process.cwd(), 'uploads');

    const directories = [
        baseUploadsDir,
        path.join(baseUploadsDir, 'avatars'),
        path.join(baseUploadsDir, 'messages'),
        path.join(baseUploadsDir, 'tasks'),
    ];

    directories.forEach((dir) => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`Created directory: ${dir}`);
        }
    });
}