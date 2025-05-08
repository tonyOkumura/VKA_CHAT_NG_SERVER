import { Request, Response } from 'express';
import knex from '../lib/knex';
import * as socketService from '../services/socketService';
import fs from 'fs';
import * as fileService from '../services/fileService';
import multer from 'multer';
import { isUserDialogParticipant, isUserGroupParticipant, getUserDetailsWithAvatar } from '../lib/dbHelpers';
import { ROOM_PREFIXES } from '../config/constants';

function isFileDownloadError(details: fileService.FileDownloadDetails | fileService.FileDownloadError): details is fileService.FileDownloadError {
    return (details as fileService.FileDownloadError).error !== undefined;
}

export const fetchAllMessages = async (req: Request, res: Response): Promise<void> => {
    const { dialog_id, group_id } = req.body;
    const limit = parseInt(req.query.limit as string || '50', 10);
    const offset = parseInt(req.query.offset as string || '0', 10);

    if (!dialog_id && !group_id) {
        res.status(400).json({ error: 'Необходимо указать dialog_id или group_id в теле запроса' });
        return;
    }
    if (dialog_id && group_id) {
        res.status(400).json({ error: 'Укажите либо dialog_id, либо group_id, но не оба' });
        return;
    }

    const user = req.user;
    if (!user || !user.id) {
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }
    const userId = user.id;
    const conversationType = dialog_id ? 'dialog' : 'group';
    const conversationId = dialog_id || group_id!;

    try {
        const isParticipant = conversationType === 'dialog'
            ? await isUserDialogParticipant(userId, conversationId)
            : await isUserGroupParticipant(userId, conversationId);
        if (!isParticipant) {
            res.status(403).json({ error: `Доступ запрещен: Вы не являетесь участником этого ${conversationType === 'dialog' ? 'диалога' : 'группы'}` });
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
                        'avatarPath', u.avatar_path
                    ) ORDER BY mr.read_at
                ) as read_by_users
            FROM message_reads mr
            JOIN users u ON u.id = mr.user_id
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
                'sender.avatar_path as senderAvatarPath',
                'm.dialog_id',
                'm.group_id',
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
            .leftJoin('users as sender', 'm.sender_id', 'sender.id')
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
            .where(conversationType === 'dialog' ? { 'm.dialog_id': conversationId } : { 'm.group_id': conversationId })
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
    conversation: { dialog_id?: string; group_id?: string },
    senderId: string,
    content: string,
    mentions: string[] = [],
    fileIds: string[] = [],
    repliedToMessageId?: string
): Promise<any | null> => {
    const { dialog_id, group_id } = conversation;
    if (!dialog_id && !group_id) {
        throw new Error('Необходимо указать dialog_id или group_id');
    }
    if (dialog_id && group_id) {
        throw new Error('Укажите либо dialog_id, либо group_id, но не оба');
    }

    const conversationType = dialog_id ? 'dialog' : 'group';
    const conversationId = dialog_id || group_id!;

    try {
        return await knex.transaction(async (trx) => {
            const isParticipant = conversationType === 'dialog'
                ? await isUserDialogParticipant(senderId, conversationId)
                : await isUserGroupParticipant(senderId, conversationId);
            if (!isParticipant) {
                throw new Error(`Вы не являетесь участником этого ${conversationType === 'dialog' ? 'диалога' : 'группы'}`);
            }

            if (repliedToMessageId) {
                const repliedMessage = await trx('messages')
                    .select('id')
                    .where({ id: repliedToMessageId, [conversationType === 'dialog' ? 'dialog_id' : 'group_id']: conversationId })
                    .first();
                if (!repliedMessage) {
                    throw new Error('Сообщение, на которое вы отвечаете, не найдено в этом чате.');
                }
            }

            const senderDetails = await getUserDetailsWithAvatar(senderId, trx);
            if (!senderDetails.username) {
                throw new Error('Пользователь не найден');
            }

            const insertedMessages = await trx('messages')
                .insert({
                    id: require('uuid').v4(),
                    dialog_id,
                    group_id,
                    sender_id: senderId,
                    sender_username: senderDetails.username,
                    content,
                    replied_to_message_id: repliedToMessageId || null,
                    created_at: new Date(),
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
                    read_at: new Date(),
                })
                .onConflict(['message_id', 'user_id'])
                .ignore();

            if (mentions.length > 0) {
                const mentionObjects = mentions.map(mentionedUserId => ({
                    message_id: savedMessageId,
                    user_id: mentionedUserId,
                    created_at: new Date(),
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
    const { messageId, content, dialog_id, group_id } = req.body;
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
    if (!dialog_id && !group_id) {
        res.status(400).json({ error: 'Необходимо указать dialog_id или group_id' });
        return;
    }
    if (dialog_id && group_id) {
        res.status(400).json({ error: 'Укажите либо dialog_id, либо group_id, но не оба' });
        return;
    }

    const conversationType = dialog_id ? 'dialog' : 'group';
    const conversationId = dialog_id || group_id!;

    try {
        const updatedMessage = await knex.transaction(async (trx) => {
            const messageCheck = await trx('messages')
                .select('sender_id', 'dialog_id', 'group_id')
                .where('id', messageId)
                .first();

            if (!messageCheck) {
                throw { status: 404, message: 'Сообщение не найдено' };
            }

            if ((dialog_id && messageCheck.dialog_id !== dialog_id) || (group_id && messageCheck.group_id !== group_id)) {
                throw { status: 400, message: 'Сообщение не относится к указанному диалогу или группе' };
            }

            if (messageCheck.sender_id !== user.id) {
                throw { status: 403, message: 'Вы не можете редактировать это сообщение' };
            }

            const updateResult = await trx('messages')
                .where('id', messageId)
                .update({
                    content: content.trim(),
                    is_edited: true,
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

        const room = conversationType === 'dialog' ? `${ROOM_PREFIXES.DIALOG}${conversationId}` : `${ROOM_PREFIXES.GROUP}${conversationId}`;
        socketService.emitToRoom(room, 'messageUpdated', updatedMessage);
        res.status(200).json(updatedMessage);
    } catch (err: any) {
        const status = err.status || 500;
        const message = err.message || 'Ошибка сервера при редактировании сообщения';
        if (!res.headersSent) {
            res.status(status).json({ error: message });
        }
    }
};

export const deleteMessage = async (req: Request, res: Response): Promise<void> => {
    const { messageId, dialog_id, group_id } = req.body;
    const user = req.user;

    if (!user || !user.id) {
        res.status(401).json({ error: 'Пользователь не аутентифицирован' });
        return;
    }
    if (!messageId || typeof messageId !== 'string') {
        res.status(400).json({ error: 'Необходимо указать messageId в теле запроса' });
        return;
    }
    if (!dialog_id && !group_id) {
        res.status(400).json({ error: 'Необходимо указать dialog_id или group_id' });
        return;
    }
    if (dialog_id && group_id) {
        res.status(400).json({ error: 'Укажите либо dialog_id, либо group_id, но не оба' });
        return;
    }

    const conversationType = dialog_id ? 'dialog' : 'group';
    const conversationId = dialog_id || group_id!;

    try {
        let deleted = false;
        await knex.transaction(async (trx) => {
            const messageInfo = await trx('messages')
                .select('sender_id', 'dialog_id', 'group_id')
                .where('id', messageId)
                .forUpdate()
                .first();

            if (!messageInfo) {
                return;
            }

            if ((dialog_id && messageInfo.dialog_id !== dialog_id) || (group_id && messageInfo.group_id !== group_id)) {
                throw { status: 400, message: 'Сообщение не относится к указанному диалогу или группе' };
            }

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

        if (deleted) {
            const room = conversationType === 'dialog' ? `${ROOM_PREFIXES.DIALOG}${conversationId}` : `${ROOM_PREFIXES.GROUP}${conversationId}`;
            const websocketPayload = { id: messageId, dialog_id, group_id };
            socketService.emitToRoom(room, 'messageDeleted', websocketPayload);
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
    const { message_ids, target_dialog_ids = [], target_group_ids = [] } = req.body;
    const user = req.user;

    if (!user || !user.id || !user.username) {
        res.status(401).json({ error: 'Пользователь не аутентифицирован или данные пользователя неполны' });
        return;
    }
    if (!Array.isArray(message_ids) || message_ids.length === 0) {
        res.status(400).json({ error: 'Необходимо указать message_ids в виде непустого массива' });
        return;
    }
    if (target_dialog_ids.length === 0 && target_group_ids.length === 0) {
        res.status(400).json({ error: 'Необходимо указать хотя бы один target_dialog_ids или target_group_ids' });
        return;
    }

    const forwardedMessagesMap: { [key: string]: { type: 'dialog' | 'group'; id: string; messageIds: string[] } } = {};

    try {
        await knex.transaction(async (trx) => {
            for (const dialogId of target_dialog_ids) {
                const canAccess = await isUserDialogParticipant(user.id, dialogId);
                if (!canAccess) {
                    throw { status: 403, message: `Вы не являетесь участником диалога ${dialogId}` };
                }
                forwardedMessagesMap[dialogId] = { type: 'dialog', id: dialogId, messageIds: [] };
            }
            for (const groupId of target_group_ids) {
                const canAccess = await isUserGroupParticipant(user.id, groupId);
                if (!canAccess) {
                    throw { status: 403, message: `Вы не являетесь участником группы ${groupId}` };
                }
                forwardedMessagesMap[groupId] = { type: 'group', id: groupId, messageIds: [] };
            }

            for (const originalMessageId of message_ids) {
                const originalMessage = await trx('messages as m')
                    .select(
                        'm.sender_id',
                        'm.sender_username',
                        'm.content',
                        'm.dialog_id',
                        'm.group_id',
                        trx.raw(`json_agg(f.*) FILTER (WHERE f.id IS NOT NULL) as files`)
                    )
                    .leftJoin('files as f', 'f.message_id', 'm.id')
                    .where('m.id', originalMessageId)
                    .groupBy('m.id', 'm.dialog_id', 'm.group_id')
                    .first();

                if (!originalMessage) {
                    continue;
                }

                const originalFiles: any[] = (originalMessage.files as any[]) || [];

                for (const [targetConvId, convInfo] of Object.entries(forwardedMessagesMap)) {
                    let newFileIds: string[] = [];

                    if (originalFiles.length > 0) {
                        const fileInserts = originalFiles.map(file => ({
                            message_id: null,
                            file_name: file.file_name,
                            file_path: file.file_path,
                            file_type: file.file_type,
                            file_size: file.file_size,
                        }));
                        
                        const insertedFiles = await trx('files')
                            .insert(fileInserts)
                            .returning('id');
                        
                        newFileIds = insertedFiles.map((row: { id: string }) => row.id);
                    }

                    const insertedForwarded = await trx('messages')
                        .insert({
                            dialog_id: convInfo.type === 'dialog' ? targetConvId : null,
                            group_id: convInfo.type === 'group' ? targetConvId : null,
                            sender_id: user.id,
                            sender_username: user.username,
                            content: originalMessage.content,
                            is_forwarded: true,
                            forwarded_from_user_id: originalMessage.sender_id,
                            forwarded_from_username: originalMessage.sender_username,
                            original_message_id: originalMessageId,
                            created_at: new Date(),
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
                            read_at: new Date(),
                        })
                        .onConflict(['message_id', 'user_id'])
                        .ignore();

                    const fullNewMessage = await fetchFullMessageDetailsById(newMessageId);
                    if (!fullNewMessage) {
                        throw new Error(`Не удалось получить данные пересланного сообщения ${newMessageId}`);
                    }

                    forwardedMessagesMap[targetConvId].messageIds.push(newMessageId);
                    const room = convInfo.type === 'dialog' ? `${ROOM_PREFIXES.DIALOG}${targetConvId}` : `${ROOM_PREFIXES.GROUP}${targetConvId}`;
                    socketService.emitToRoom(room, 'newMessage', fullNewMessage);
                }
            }
        });

        res.status(200).json({
            success: true,
            forwarded_messages: Object.fromEntries(
                Object.entries(forwardedMessagesMap).map(([id, info]) => [id, info.messageIds])
            ),
        });
    } catch (err: any) {
        const status = err.status || 500;
        const message = err.message || 'Ошибка сервера при пересылке сообщений';
        if (!res.headersSent) {
            res.status(status).json({ success: false, error: message });
        }
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

        const { dialog_id, group_id, content = '' } = req.body;

        if (!dialog_id && !group_id) {
            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            res.status(400).json({ error: 'Не указан ID диалога или группы (dialog_id или group_id)' });
            return;
        }
        if (dialog_id && group_id) {
            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            res.status(400).json({ error: 'Укажите либо dialog_id, либо group_id, но не оба' });
            return;
        }

        const conversationType = dialog_id ? 'dialog' : 'group';
        const conversationId = dialog_id || group_id!;

        const isParticipant = conversationType === 'dialog'
            ? await isUserDialogParticipant(sender_id, conversationId)
            : await isUserGroupParticipant(sender_id, conversationId);
        if (!isParticipant) {
            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            res.status(403).json({ error: `Вы не являетесь участником этого ${conversationType === 'dialog' ? 'диалога' : 'группы'}` });
            return;
        }

        fileInfoFromService = await fileService.storeUploadedFile(req.file, 'messages');

        const fullMessageData = await knex.transaction(async (trx) => {
            const senderDetails = await getUserDetailsWithAvatar(sender_id, trx);
            if (!senderDetails.username) {
                throw new Error('Пользователь не найден');
            }

            const insertedMessages = await trx('messages')
                .insert({
                    id: require('uuid').v4(),
                    dialog_id,
                    group_id,
                    sender_id,
                    sender_username: senderDetails.username,
                    content,
                    created_at: new Date(),
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
                    file_size: fileInfoFromService!.size,
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
                    read_at: new Date(),
                })
                .onConflict(['message_id', 'user_id'])
                .ignore();

            const messageDetails = await fetchFullMessageDetailsById(savedMessageId!);
            if (!messageDetails) {
                throw new Error(`Не удалось получить данные сообщения ${savedMessageId} после сохранения в транзакции.`);
            }
            return messageDetails;
        });

        const room = conversationType === 'dialog' ? `${ROOM_PREFIXES.DIALOG}${conversationId}` : `${ROOM_PREFIXES.GROUP}${conversationId}`;
        socketService.emitToRoom(room, 'newMessage', fullMessageData);

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
                download_url: `/api/messages/files/download_body/${savedDbFileId}`,
            },
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
            .select('m.dialog_id', 'm.group_id')
            .join('messages as m', 'f.message_id', 'm.id')
            .where('f.id', file_id)
            .first();

        if (!fileCheck || (!fileCheck.dialog_id && !fileCheck.group_id)) {
            res.status(404).json({ error: 'Файл не найден или не привязан к сообщению' });
            return;
        }

        const conversationType = fileCheck.dialog_id ? 'dialog' : 'group';
        const conversationId = fileCheck.dialog_id || fileCheck.group_id!;

        const participantCheck = conversationType === 'dialog'
            ? await isUserDialogParticipant(userId, conversationId)
            : await isUserGroupParticipant(userId, conversationId);
        if (!participantCheck) {
            res.status(403).json({ error: `Доступ к информации о файле запрещен: Вы не участник этого ${conversationType === 'dialog' ? 'диалога' : 'группы'}` });
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

const fetchFullMessageDetailsById = async (messageId: string, ): Promise<any | null> => {
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
                        'read_at', mr.read_at::text, 'avatarPath', u.avatar_path
                    ) ORDER BY mr.read_at
                ) as read_by_users
            FROM message_reads mr
            JOIN users u ON u.id = mr.user_id
            GROUP BY message_id`
        );

        const result = await knex('messages as m')
            .with('message_files_cte', messageFilesCte)
            .with('message_reads_agg_cte', messageReadsAggCte)
            .select([
                'm.id',
                'm.dialog_id',
                'm.group_id',
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
                'sender.avatar_path as senderAvatarPath',
            ])
            .leftJoin('users as sender', 'm.sender_id', 'sender.id')
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
                read_at: new Date(reader.read_at).toISOString(),
            })),
            files: (result.files || []).map((file: any) => ({
                ...file,
                created_at: new Date(file.created_at).toISOString(),
            })),
        };
    } catch (err: any) {
        return null;
    }
};