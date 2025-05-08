import { Request, Response } from 'express';
import knex from '../lib/knex';
import * as socketService from '../services/socketService';
import fs from 'fs';
import * as fileService from '../services/fileService';
import multer from 'multer';

function isFileDownloadError(details: fileService.FileDownloadDetails | fileService.FileDownloadError): details is fileService.FileDownloadError {
    return (details as fileService.FileDownloadError).error !== undefined;
}

export const fetchAllMessagesByConversationId = async (req: Request, res: Response): Promise<void> => {
    const { conversation_id } = req.body;
    const limit = parseInt(req.query.limit as string || '50', 10);
    const offset = parseInt(req.query.offset as string || '0', 10);

    if (!conversation_id || typeof conversation_id !== 'string') {
        res.status(400).json({ error: 'Необходимо указать conversation_id в теле запроса' });
        return;
    }

    const user = req.user;
    if (!user || !user.id) {
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }
    const userId = user.id;

    try {
        const participant = await isUserParticipant(userId, conversation_id);
        if (!participant) {
            res.status(403).json({ error: 'Доступ запрещен: Вы не являетесь участником этого чата' });
            return;
        }

        const messageFilesCte = knex.raw(
            `SELECT
                message_id,
                json_agg(
                    json_build_object(
                        'id', f.id,
                        'file_name', f.file_name,
                        'file_type', f.file_type,
                        'file_size', f.file_size,
                        'created_at', f.created_at::text,
                        'download_url', '/api/messages/files/download_body/' || f.id::text
                    ) ORDER BY f.created_at
                ) as files
            FROM files f
            GROUP BY message_id`
        );

        const messageReadsAggCte = knex.raw(
            `SELECT
                message_id,
                json_agg(
                    json_build_object(
                        'contact_id', u.id,
                        'username', u.username,
                        'email', u.email,
                        'read_at', mr.read_at::text,
                        'avatarPath', ua.file_path
                    ) ORDER BY mr.read_at
                ) as read_by_users
            FROM message_reads mr
            JOIN users u ON u.id = mr.user_id
            LEFT JOIN user_avatars ua ON u.id = ua.user_id
            GROUP BY message_id`
        );

        const messagesData = await knex('messages as m')
            .with('message_files_cte', messageFilesCte)
            .with('message_reads_agg_cte', messageReadsAggCte)
            .select(
                'm.id',
                'm.content',
                'm.sender_id',
                'm.sender_username',
                'sender_avatar.file_path as senderAvatarPath',
                'm.conversation_id',
                knex.raw('m.created_at::text AS created_at'),
                'm.is_edited',
                'm.replied_to_message_id',
                'replied_msg.sender_username as replied_to_sender_username',
                knex.raw(
                    `CASE
                        WHEN replied_msg.content IS NOT NULL THEN LEFT(replied_msg.content, 50) || CASE WHEN LENGTH(replied_msg.content) > 50 THEN '...' ELSE '' END
                        WHEN replied_file.file_name IS NOT NULL THEN 'Файл: ' || replied_file.file_name
                        ELSE NULL
                    END AS replied_to_content_preview`
                ),
                'm.is_forwarded',
                'm.forwarded_from_user_id',
                'm.forwarded_from_username',
                'm.original_message_id',
                knex.raw(
                    `CASE
                        WHEN ?::UUID IS NOT NULL THEN EXISTS (
                            SELECT 1
                            FROM message_reads mr
                            WHERE mr.message_id = m.id
                            AND mr.user_id = ?::UUID
                        )
                        ELSE FALSE
                    END AS is_read_by_current_user`,
                    [userId, userId]
                ),
                knex.raw('COALESCE(mra.read_by_users, \'[]\'::json) AS read_by_users'),
                knex.raw('COALESCE(mf.files, \'[]\'::json) AS files')
            )
            .leftJoin('user_avatars as sender_avatar', 'm.sender_id', 'sender_avatar.user_id')
            .leftJoin('message_files_cte as mf', 'mf.message_id', 'm.id')
            .leftJoin('message_reads_agg_cte as mra', 'mra.message_id', 'm.id')
            .leftJoin('messages as replied_msg', 'replied_msg.id', 'm.replied_to_message_id')
            .leftJoin(
                knex.raw(`(
                    SELECT DISTINCT ON (message_id) message_id, file_name 
                    FROM files 
                    ORDER BY message_id, created_at ASC
                ) as replied_file`),
                'replied_file.message_id', 
                'replied_msg.id'
            )
            .where('m.conversation_id', conversation_id)
            .orderBy('m.created_at', 'desc')
            .limit(limit)
            .offset(offset);

        const formattedMessages = messagesData.map((msg: any) => ({
            ...msg,
            created_at: new Date(msg.created_at).toISOString(),
            read_by_users: (msg.read_by_users || []).map((reader: any) => ({ 
                ...reader,
                read_at: new Date(reader.read_at).toISOString(),
            })),
            files: (msg.files || []).map((file: any) => ({ ...file, created_at: new Date(file.created_at).toISOString() })),
            is_unread: !msg.is_read_by_current_user && msg.sender_id !== userId,
        }));

        res.json(formattedMessages);
    } catch (err: any) {
        res.status(500).json({ error: 'Не удалось получить сообщения' });
    }
};

export const saveMessage = async (
    conversationId: string,
    senderId: string,
    content: string,
    mentions: string[] = [],
    fileIds?: string[],
    repliedToMessageId?: string
): Promise<any | null> => {
    try {
        return await knex.transaction(async (trx) => {
            if (repliedToMessageId) {
                const repliedMessage = await trx('messages')
                    .select('id')
                    .where({ id: repliedToMessageId, conversation_id: conversationId })
                    .first();
                if (!repliedMessage) {
                    throw new Error('Сообщение, на которое вы отвечаете, не найдено в этом чате.');
                }
            }

            const insertedMessages = await trx('messages')
                .insert({
                    conversation_id: conversationId,
                    sender_id: senderId,
                    content,
                    replied_to_message_id: repliedToMessageId || null
                })
                .returning(['id', 'created_at']);
            
            if (!insertedMessages || insertedMessages.length === 0) {
                throw new Error('Не удалось создать запись сообщения.');
            }
            const savedMessageId = insertedMessages[0].id;

            if (fileIds && fileIds.length > 0) {
                for (const fileId of fileIds) {
                    await trx('files')
                        .where('id', fileId)
                        .update({ message_id: savedMessageId });
                }
            }

            await trx('message_reads')
                .insert({ 
                    message_id: savedMessageId, 
                    user_id: senderId, 
                    read_at: new Date()
                })
                .onConflict(['message_id', 'user_id'])
                .ignore();

            if (mentions.length > 0) {
                const mentionObjects = mentions.map(mentionedUserId => ({
                    message_id: savedMessageId,
                    user_id: mentionedUserId,
                    created_at: new Date()
                }));
                await trx('message_mentions')
                    .insert(mentionObjects)
                    .onConflict(['message_id', 'user_id'])
                    .ignore();
            }

            const fullMessage = await fetchFullMessageDetailsById(savedMessageId);
            if (!fullMessage) {
                throw new Error('Не удалось получить детали сообщения после сохранения в транзакции.');
            }
            
            return fullMessage;
        });
    } catch (err: any) {
        throw err;
    }
};

export const editMessage = async (req: Request, res: Response): Promise<void> => {
    const { messageId, content } = req.body;
    const user = req.user;

    if (!user || !user.id) {
        res.status(401).json({ error: 'Пользователь не аутентифицирован' });
        return;
    }
    if (!messageId || typeof messageId !== 'string') {
        res.status(400).json({ error: 'Необходимо указать messageId' });
        return;
    }
    if (content === undefined || content === null || typeof content !== 'string') {
        res.status(400).json({ error: 'Необходимо указать content (текст сообщения)' });
        return;
    }

    let conversation_id: string | null = null;

    try {
        const updatedMessage = await knex.transaction(async (trx) => {
            const messageCheck = await trx('messages')
                .select('sender_id', 'conversation_id')
                .where('id', messageId)
                .first();

            if (!messageCheck) {
                throw { status: 404, message: 'Сообщение не найдено' };
            }

            conversation_id = messageCheck.conversation_id;

            if (messageCheck.sender_id !== user.id) {
                throw { status: 403, message: 'Вы не можете редактировать это сообщение' };
            }

            const updateResult = await trx('messages')
                .where('id', messageId)
                .update({
                    content: content.trim(),
                    is_edited: true
                });

            if (updateResult === 0) {
                throw { status: 404, message: 'Сообщение не найдено для обновления' };
            }
            
            const fullUpdatedMessage = await fetchFullMessageDetailsById(messageId);
            if (!fullUpdatedMessage) {
                throw { status: 500, message: 'Критическая ошибка при получении обновленного сообщения' };
            }

            return fullUpdatedMessage;
        });

        if (updatedMessage && conversation_id) {
            socketService.emitToRoom(conversation_id, 'messageUpdated', updatedMessage);
            res.status(200).json(updatedMessage);
        } else {
            res.status(500).json({ error: 'Неожиданная ошибка сервера после редактирования сообщения' });
        }
    } catch (err: any) {
        const status = err.status || 500;
        const message = err.message || 'Ошибка сервера при редактировании сообщения';
        if (!res.headersSent) {
            res.status(status).json({ error: message });
        }
    }
};

export const deleteMessage = async (req: Request, res: Response): Promise<void> => {
    const { messageId } = req.body;
    const user = req.user;

    if (!user || !user.id) {
        res.status(401).json({ error: 'Пользователь не аутентифицирован' });
        return;
    }
    if (!messageId || typeof messageId !== 'string') {
        res.status(400).json({ error: 'Необходимо указать messageId в теле запроса' });
        return;
    }

    let conversation_id_for_event: string | null = null;
    let deleted = false;

    try {
        await knex.transaction(async (trx) => {
            const messageInfo = await trx('messages')
                .select('conversation_id', 'sender_id')
                .where('id', messageId)
                .forUpdate()
                .first();

            if (!messageInfo) {
                return;
            }

            conversation_id_for_event = messageInfo.conversation_id;

            if (messageInfo.sender_id !== user.id) {
                throw { status: 403, message: 'Вы не можете удалить это сообщение' };
            }

            const deletedRows = await trx('messages')
                .where('id', messageId)
                .del();

            if (deletedRows > 0) {
                deleted = true;
            }
        });

        if (deleted && conversation_id_for_event) {
            const websocketPayload = { id: messageId, conversation_id: conversation_id_for_event };
            socketService.emitToRoom(conversation_id_for_event, 'messageDeleted', websocketPayload);
        }

        res.status(204).send();
    } catch (err: any) {
        const status = err.status || 500;
        const message = err.message || 'Ошибка сервера при удалении сообщения';
        if (!res.headersSent) {
            res.status(status).json({ error: message });
        }
    }
};

export const forwardMessages = async (req: Request, res: Response): Promise<void> => {
    const { message_ids, target_conversation_ids } = req.body;
    const user = req.user;

    if (!user || !user.id || !user.username) {
        res.status(401).json({ error: 'Пользователь не аутентифицирован или данные пользователя неполны' });
        return;
    }
    if (!Array.isArray(message_ids) || message_ids.length === 0 ||
        !Array.isArray(target_conversation_ids) || target_conversation_ids.length === 0) {
        res.status(400).json({ error: 'Необходимо указать message_ids и target_conversation_ids в виде непустых массивов' });
        return;
    }

    const forwardedMessagesMap: { [key: string]: string[] } = {};

    try {
        await knex.transaction(async (trx) => {
            for (const targetConvId of target_conversation_ids) {
                const canAccess = await isUserParticipant(user.id, targetConvId);
                if (!canAccess) {
                    throw { status: 403, message: `Вы не являетесь участником чата ${targetConvId}` };
                }
                forwardedMessagesMap[targetConvId] = [];
            }

            for (const originalMessageId of message_ids) {
                const originalMessage = await trx('messages as m')
                    .select(
                        'm.sender_id',
                        'm.sender_username',
                        'm.content',
                        trx.raw(`json_agg(f.*) FILTER (WHERE f.id IS NOT NULL) as files`)
                    )
                    .leftJoin('files as f', 'f.message_id', 'm.id')
                    .where('m.id', originalMessageId)
                    .groupBy('m.id')
                    .first();

                if (!originalMessage) {
                    continue;
                }

                const originalFiles: any[] = (originalMessage.files as any[]) || [];

                for (const targetConvId of target_conversation_ids) {
                    let newFileIds: string[] = [];

                    if (originalFiles.length > 0) {
                        const fileInserts = originalFiles.map(file => ({
                            message_id: null,
                            file_name: file.file_name,
                            file_path: file.file_path,
                            file_type: file.file_type,
                            file_size: file.file_size
                        }));
                        
                        const insertedFiles = await trx('files')
                            .insert(fileInserts)
                            .returning('id');
                        
                        newFileIds = insertedFiles.map((row: { id: string }) => row.id);
                    }

                    const insertedForwarded = await trx('messages')
                        .insert({
                            conversation_id: targetConvId,
                            sender_id: user.id,
                            sender_username: user.username,
                            content: originalMessage.content,
                            is_forwarded: true,
                            forwarded_from_user_id: originalMessage.sender_id,
                            forwarded_from_username: originalMessage.sender_username,
                            original_message_id: originalMessageId
                        })
                        .returning('id');
                    
                    const newMessageId = insertedForwarded[0].id;

                    if (newFileIds.length > 0) {
                        await trx('files')
                            .whereIn('id', newFileIds)
                            .update({ message_id: newMessageId });
                    }

                    await trx('message_reads')
                        .insert({
                            message_id: newMessageId,
                            user_id: user.id,
                            read_at: new Date()
                        })
                        .onConflict(['message_id', 'user_id'])
                        .ignore();

                    const fullNewMessage = await fetchFullMessageDetailsById(newMessageId);
                    if (!fullNewMessage) {
                        throw new Error(`Не удалось получить данные пересланного сообщения ${newMessageId}`);
                    }

                    forwardedMessagesMap[targetConvId].push(newMessageId);
                    socketService.emitToRoom(targetConvId, 'newMessage', fullNewMessage);
                }
            }
        });

        res.status(200).json({
            success: true,
            forwarded_messages: forwardedMessagesMap
        });
    } catch (err: any) {
        const status = err.status || 500;
        const message = err.message || 'Ошибка сервера при пересылке сообщений';
        if (!res.headersSent) {
            res.status(status).json({ success: false, error: message });
        }
    }
};

const isUserParticipant = async (userId: string, conversationId: string): Promise<boolean> => {
    try {
        const participant = await knex('conversation_participants')
            .select(knex.raw('1'))
            .where({
                user_id: userId,
                conversation_id: conversationId
            })
            .first();
        
        return !!participant;
    } catch (error) {
        return false;
    }
};

const fetchFullMessageDetailsById = async (messageId: string): Promise<any | null> => {
    try {
        const messageFilesCte = knex.raw(
            `SELECT
                message_id,
                json_agg(
                    json_build_object(
                        'id', f.id, 'file_name', f.file_name, 'file_type', f.file_type,
                        'file_size', f.file_size, 'created_at', f.created_at::text,
                        'download_url', '/api/messages/files/download_body/' || f.id::text
                    ) ORDER BY f.created_at
                ) as files
            FROM files f
            GROUP BY message_id`
        );
        const messageReadsAggCte = knex.raw(
            `SELECT
                message_id,
                json_agg(
                    json_build_object(
                        'contact_id', u.id, 'username', u.username, 'email', u.email,
                        'read_at', mr.read_at::text, 'avatarPath', ua.file_path
                    ) ORDER BY mr.read_at
                ) as read_by_users
            FROM message_reads mr
            JOIN users u ON u.id = mr.user_id
            LEFT JOIN user_avatars ua ON u.id = ua.user_id
            GROUP BY message_id`
        );

        const result = await knex('messages as m')
            .with('message_files_cte', messageFilesCte)
            .with('message_reads_agg_cte', messageReadsAggCte)
            .select([
                'm.id',
                'm.conversation_id',
                'm.sender_id',
                'm.sender_username',
                'm.content',
                knex.raw('m.created_at::text AS created_at'),
                'm.is_edited',
                'm.replied_to_message_id',
                'replied_msg.sender_username as replied_to_sender_username',
                knex.raw(
                    `CASE
                        WHEN replied_msg.content IS NOT NULL THEN LEFT(replied_msg.content, 50) || CASE WHEN LENGTH(replied_msg.content) > 50 THEN '...' ELSE '' END
                        WHEN replied_file.file_name IS NOT NULL THEN 'Файл: ' || replied_file.file_name
                        ELSE NULL
                    END AS replied_to_content_preview`
                ),
                'm.is_forwarded',
                'm.forwarded_from_user_id',
                'm.forwarded_from_username',
                'm.original_message_id',
                knex.raw('TRUE AS is_read_by_current_user'),
                knex.raw('COALESCE(mra.read_by_users, \'[]\'::json) AS read_by_users'),
                knex.raw('COALESCE(mf.files, \'[]\'::json) AS files'),
                'sender_avatar.file_path as senderAvatarPath'
            ])
            .leftJoin('user_avatars as sender_avatar', 'm.sender_id', 'sender_avatar.user_id')
            .leftJoin('message_files_cte as mf', 'mf.message_id', 'm.id')
            .leftJoin('message_reads_agg_cte as mra', 'mra.message_id', 'm.id')
            .leftJoin('messages as replied_msg', 'replied_msg.id', 'm.replied_to_message_id')
            .leftJoin(
                knex.raw(`(
                    SELECT DISTINCT ON (message_id) message_id, file_name 
                    FROM files 
                    ORDER BY message_id, created_at ASC
                ) as replied_file`),
                'replied_file.message_id', 
                'replied_msg.id'
            )
            .where('m.id', messageId)
            .first();

        if (!result) {
            return null;
        }
        return {
            ...result,
            created_at: new Date(result.created_at).toISOString(),
            read_by_users: (result.read_by_users || []).map((reader: any) => ({
                ...reader,
                read_at: new Date(reader.read_at).toISOString()
            })),
            files: (result.files || []).map((file: any) => ({
                ...file,
                created_at: new Date(file.created_at).toISOString()
            }))
        };
    } catch (err: any) {
        return null;
    }
};

export const uploadMessageFileAndCreateMessage = async (req: Request, res: Response): Promise<void> => {
    let fileInfoFromService: fileService.FileUploadResult | null = null;
    let savedDbFileId: string | null = null;
    let savedMessageId: string | null = null;

    try {
        if (!req.file) {
            res.status(400).json({ error: 'Файл не был загружен' });
            return;
        }

        const user = req.user;
        if (!user || !user.id) {
            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            res.status(401).json({ error: 'Пользователь не аутентифицирован' });
            return;
        }
        const sender_id = user.id;

        const { conversation_id, content = '' } = req.body;

        if (!conversation_id) {
            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            res.status(400).json({ error: 'Не указан ID разговора (conversation_id)' });
            return;
        }

        fileInfoFromService = await fileService.storeUploadedFile(req.file, 'messages');

        const fullMessageData = await knex.transaction(async (trx) => {
            const insertedMessages = await trx('messages')
                .insert({
                    conversation_id,
                    sender_id,
                    content,
                })
                .returning('id');
            
            if (!insertedMessages || insertedMessages.length === 0) {
                throw new Error('Не удалось создать запись сообщения в БД.');
            }
            savedMessageId = insertedMessages[0].id;

            const insertedFiles = await trx('files')
                .insert({
                    message_id: savedMessageId,
                    file_name: fileInfoFromService!.originalName,
                    file_path: fileInfoFromService!.filePathInDb,
                    file_type: fileInfoFromService!.mimeType,
                    file_size: fileInfoFromService!.size
                })
                .returning('id');
            
            if (!insertedFiles || insertedFiles.length === 0) {
                throw new Error('Не удалось создать запись файла в БД.');
            }
            savedDbFileId = insertedFiles[0].id;

            await trx('message_reads')
                .insert({
                    message_id: savedMessageId,
                    user_id: sender_id,
                    read_at: new Date()
                })
                .onConflict(['message_id', 'user_id'])
                .ignore();

            const messageDetails = await fetchFullMessageDetailsById(savedMessageId!);
            if (!messageDetails) {
                throw new Error(`Не удалось получить данные сообщения ${savedMessageId} после сохранения в транзакции.`);
            }
            return messageDetails;
        });

        if (fullMessageData && fullMessageData.conversation_id) {
            socketService.emitToRoom(fullMessageData.conversation_id, 'newMessage', fullMessageData);
        }

        res.status(201).json({
            message: 'Файл успешно загружен и сообщение создано',
            fileId: savedDbFileId,
            messageId: savedMessageId,
            fileInfo: {
                id: savedDbFileId,
                file_name: fileInfoFromService!.originalName,
                file_type: fileInfoFromService!.mimeType,
                file_size: fileInfoFromService!.size,
                created_at: new Date().toISOString(),
                download_url: `/api/messages/files/download_body/${savedDbFileId}`
            }
        });
    } catch (error: any) {
        if (fileInfoFromService && fileInfoFromService.filePathInDb) {
            try {
                await fileService.deleteFileFromDiskByDbPath(fileInfoFromService.filePathInDb);
            } catch (deleteErr) {}
        } else if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (unlinkError) {}
        }

        if (!res.headersSent) {
            if (error instanceof multer.MulterError) {
                res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой (макс. 10GB)' : `Ошибка Multer: ${error.message}` });
            } else {
                const status = error.status || 500;
                res.status(status).json({ error: error.message || 'Не удалось загрузить файл и создать сообщение' });
            }
        }
    }
};

export const downloadMessageFile = async (req: Request, res: Response): Promise<void> => {
    const { file_id } = req.body;
    const user = req.user;

    if (!user || !user.id) {
        res.status(401).json({ error: 'Пользователь не аутентифицирован' });
        return;
    }
    const userId = user.id;

    if (!file_id) {
        res.status(400).json({ error: 'Необходимо передать file_id в теле запроса' });
        return;
    }

    try {
        const fileDetails = await fileService.getMessageFileDetailsForDownload(file_id, userId);

        if (isFileDownloadError(fileDetails)) {
            res.status(fileDetails.status).json({ error: fileDetails.error });
            return;
        }
        
        const { absolutePathOnDisk, fileNameToUser, mimeType } = fileDetails;

        res.setHeader('Content-Type', mimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileNameToUser)}"`);

        const fileStream = fs.createReadStream(absolutePathOnDisk);
        
        fileStream.on('error', () => {
            if (!res.headersSent) {
                res.status(500).json({ error: 'Не удалось отправить файл' });
            }
        });

        fileStream.pipe(res);
    } catch (error: any) {
        if (!res.headersSent) {
            if (error.code === '22P02') {
                res.status(400).json({ error: 'Неверный формат ID файла' });
            } else {
                res.status(500).json({ error: 'Не удалось скачать файл' });
            }
        }
    }
};

export const getMessageFileInfo = async (req: Request, res: Response): Promise<void> => {
    const { file_id } = req.body;
    const user = req.user;

    if (!user || !user.id) {
        res.status(401).json({ error: 'Пользователь не аутентифицирован' });
        return;
    }
    const userId = user.id;

    if (!file_id) {
        res.status(400).json({ error: 'Необходимо передать file_id в теле запроса' });
        return;
    }

    try {
        const fileCheck = await knex('files as f')
            .select('m.conversation_id')
            .join('messages as m', 'f.message_id', 'm.id')
            .where('f.id', file_id)
            .first();

        if (!fileCheck || !fileCheck.conversation_id) {
            res.status(404).json({ error: 'Файл не найден или не привязан к сообщению' });
            return;
        }
        const { conversation_id } = fileCheck;

        const participantCheck = await isUserParticipant(userId, conversation_id);
        if (!participantCheck) {
            res.status(403).json({ error: 'Доступ к информации о файле запрещен' });
            return;
        }

        const fileInfo = await knex('files')
            .select(
                'id',
                'file_name',
                'file_type',
                'file_size',
                knex.raw('created_at::text'),
                knex.raw(`'/api/messages/files/download_body/' || id::text as download_url`)
            )
            .where('id', file_id)
            .first();

        if (!fileInfo) {
            res.status(404).json({ error: 'Файл не найден' });
            return;
        }

        res.json(fileInfo);
    } catch (error: any) {
        if (!res.headersSent) {
            if (error.code === '22P02') {
                res.status(400).json({ error: 'Неверный формат ID файла' });
            } else {
                res.status(500).json({ error: 'Не удалось получить информацию о файле' });
            }
        }
    }
};