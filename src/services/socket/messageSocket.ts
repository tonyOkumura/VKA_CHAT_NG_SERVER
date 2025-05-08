import { Socket } from 'socket.io';
import { saveMessage } from '../../controllers/messagesController';
import { fetchAllDialogParticipants, fetchAllGroupParticipants } from '../../lib/dbHelpers';
import { emitToRoom, emitToUser, userSockets } from './socketService';
import { ROOM_PREFIXES } from '../../config/constants';
import { MessageData, MarkMessagesAsReadData, TypingData, checkRateLimit, getCachedUserDetails, isValidUUID } from './socketUtils';
import knex from '../../lib/knex';

export async function handleSendMessage(socket: Socket, message: MessageData): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId || userId !== message.sender_id) {
        socket.emit('sendMessage_failed', {
            errorCode: 'AUTH_MISMATCH',
            message: 'Authentication mismatch or user not authenticated',
        });
        return;
    }

    const { dialog_id, group_id, sender_id, content, mentions = [], fileIds = [], replied_to_message_id } = message;

    if (!dialog_id && !group_id) {
        socket.emit('sendMessage_failed', {
            errorCode: 'MISSING_ID',
            message: 'dialog_id or group_id is required',
        });
        return;
    }

    if (dialog_id && group_id) {
        socket.emit('sendMessage_failed', {
            errorCode: 'INVALID_INPUT',
            message: 'Specify either dialog_id or group_id, not both',
        });
        return;
    }

    if (!content && (!fileIds || fileIds.length === 0)) {
        socket.emit('sendMessage_failed', {
            errorCode: 'EMPTY_MESSAGE',
            message: 'Message content or files cannot be empty',
        });
        return;
    }

    if ((dialog_id && !isValidUUID(dialog_id)) || (group_id && !isValidUUID(group_id))) {
        socket.emit('sendMessage_failed', {
            errorCode: 'INVALID_ID',
            message: 'Invalid dialog or group ID format',
        });
        return;
    }

    if (content && content.length > 2000) {
        socket.emit('sendMessage_failed', {
            errorCode: 'CONTENT_TOO_LONG',
            message: 'Message content exceeds 2000 characters',
        });
        return;
    }

    if (!checkRateLimit(userId)) {
        socket.emit('sendMessage_failed', {
            errorCode: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many messages sent, please wait',
        });
        return;
    }

    const conversationType = dialog_id ? 'dialog' : 'group';
    const conversationId = dialog_id || group_id!;
    const room = conversationType === 'dialog' ? `${ROOM_PREFIXES.DIALOG}${conversationId}` : `${ROOM_PREFIXES.GROUP}${conversationId}`;

    try {
        const isParticipant = conversationType === 'dialog'
            ? await knex('dialog_participants').where({ dialog_id: conversationId, user_id: userId }).first()
            : await knex('group_participants').where({ group_id: conversationId, user_id: userId }).first();

        if (!isParticipant) {
            socket.emit('sendMessage_failed', {
                errorCode: 'NOT_PARTICIPANT',
                message: `You are not a participant of this ${conversationType}`,
            });
            return;
        }

        if (mentions.some(id => !isValidUUID(id)) || fileIds.some(id => !isValidUUID(id))) {
            socket.emit('sendMessage_failed', {
                errorCode: 'INVALID_IDS',
                message: 'Invalid mention or file ID format',
            });
            return;
        }

        if (replied_to_message_id && !isValidUUID(replied_to_message_id)) {
            socket.emit('sendMessage_failed', {
                errorCode: 'INVALID_REPLY_ID',
                message: 'Invalid replied-to message ID format',
            });
            return;
        }

        const savedMessage = await saveMessage(
            { dialog_id, group_id },
            sender_id,
            content || '',
            mentions,
            fileIds,
            replied_to_message_id
        );
        if (!savedMessage) {
            throw new Error('Failed to save message or retrieve its details');
        }

        emitToRoom(room, 'newMessage', savedMessage);

        const participants = conversationType === 'dialog'
            ? await fetchAllDialogParticipants(conversationId)
            : await fetchAllGroupParticipants(conversationId);

        const memberIds = participants.map((p: any) => p.id);
        memberIds.forEach((memberId: string) => {
            if (memberId !== sender_id) {
                emitToUser(memberId, 'notification', {
                    type: 'new_message',
                    content: `New message from ${savedMessage.sender_username || sender_id}`,
                    related_dialog_id: dialog_id || undefined,
                    related_group_id: group_id || undefined,
                    related_message_id: savedMessage.id,
                });
            }
        });

        mentions.forEach((mentionedUserId: string) => {
            if (mentionedUserId !== sender_id) {
                emitToUser(mentionedUserId, 'notification', {
                    type: 'mention',
                    content: `You were mentioned by ${savedMessage.sender_username || sender_id}`,
                    related_dialog_id: dialog_id || undefined,
                    related_group_id: group_id || undefined,
                    related_message_id: savedMessage.id,
                });
            }
        });

        await knex('message_reads')
            .insert({
                message_id: savedMessage.id,
                user_id: sender_id,
                read_at: new Date(),
            })
            .onConflict(['message_id', 'user_id'])
            .ignore();

        const senderDetails = await getCachedUserDetails(sender_id);
        emitToRoom(room, 'messageReadUpdate', {
            dialog_id: dialog_id || undefined,
            group_id: group_id || undefined,
            message_id: savedMessage.id,
            user_id: sender_id,
            username: senderDetails.username,
            avatarUrl: senderDetails.avatarPath,
            read_at: new Date().toISOString(),
        });

        console.log(JSON.stringify({
            event: 'sendMessage',
            userId,
            conversationType,
            conversationId,
            messageId: savedMessage.id,
            status: 'success',
        }));
    } catch (error: any) {
        console.error(JSON.stringify({
            event: 'sendMessage',
            userId,
            conversationType,
            conversationId,
            errorCode: error.code || 'DB_ERROR',
            errorMessage: error.message || 'Failed to send message',
        }));
        socket.emit('sendMessage_failed', {
            errorCode: error.code || 'DB_ERROR',
            message: error.message || 'Failed to send message',
            originalMessage: message,
        });
    }
}

export async function handleEditMessage(socket: Socket, { message_id, content }: { message_id: string; content: string }): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId) {
        socket.emit('editMessage_failed', {
            errorCode: 'AUTH_MISMATCH',
            message: 'User not authenticated',
        });
        return;
    }

    if (!isValidUUID(message_id)) {
        socket.emit('editMessage_failed', {
            errorCode: 'INVALID_ID',
            message: 'Invalid message ID format',
        });
        return;
    }

    if (!content || content.length > 2000) {
        socket.emit('editMessage_failed', {
            errorCode: 'INVALID_CONTENT',
            message: 'Message content must be non-empty and not exceed 2000 characters',
        });
        return;
    }

    try {
        const message = await knex('messages')
            .select('sender_id', 'dialog_id', 'group_id')
            .where('id', message_id)
            .first();

        if (!message) {
            socket.emit('editMessage_failed', {
                errorCode: 'MESSAGE_NOT_FOUND',
                message: 'Message not found',
            });
            return;
        }

        if (message.sender_id !== userId) {
            socket.emit('editMessage_failed', {
                errorCode: 'PERMISSION_DENIED',
                message: 'You can only edit your own messages',
            });
            return;
        }

        const conversationType = message.dialog_id ? 'dialog' : 'group';
        const conversationId = message.dialog_id || message.group_id!;
        const room = conversationType === 'dialog' ? `${ROOM_PREFIXES.DIALOG}${conversationId}` : `${ROOM_PREFIXES.GROUP}${conversationId}`;

        await knex('messages')
            .where('id', message_id)
            .update({
                content,
                updated_at: new Date(),
            });

        const updatedMessage = await knex('messages')
            .select('id', 'dialog_id', 'group_id', 'sender_id', 'content', 'updated_at')
            .where('id', message_id)
            .first();

        const senderDetails = await getCachedUserDetails(userId);
        emitToRoom(room, 'messageEdited', {
            message_id,
            dialog_id: updatedMessage.dialog_id || undefined,
            group_id: updatedMessage.group_id || undefined,
            sender_id: updatedMessage.sender_id,
            content: updatedMessage.content,
            sender_username: senderDetails.username,
            avatarUrl: senderDetails.avatarPath,
            updated_at: new Date(updatedMessage.updated_at).toISOString(),
        });

        console.log(JSON.stringify({
            event: 'editMessage',
            userId,
            messageId: message_id,
            conversationType,
            conversationId,
            status: 'success',
        }));
    } catch (error: any) {
        console.error(JSON.stringify({
            event: 'editMessage',
            userId,
            messageId: message_id,
            errorCode: error.code || 'DB_ERROR',
            errorMessage: error.message || 'Failed to edit message',
        }));
        socket.emit('editMessage_failed', {
            errorCode: error.code || 'DB_ERROR',
            message: 'Failed to edit message',
        });
    }
}

export async function handleMarkMessagesAsRead(
    socket: Socket,
    { dialog_id, group_id, message_ids }: MarkMessagesAsReadData
): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId) {
        console.warn(JSON.stringify({
            event: 'markMessagesAsRead',
            socketId: socket.id,
            status: 'failed',
            reason: 'Unauthenticated socket',
        }));
        return;
    }

    if (!message_ids || message_ids.length === 0) {
        console.warn(JSON.stringify({
            event: 'markMessagesAsRead',
            userId,
            status: 'failed',
            reason: 'No message IDs provided',
        }));
        return;
    }

    if (!dialog_id && !group_id) {
        socket.emit('markMessagesAsRead_failed', {
            errorCode: 'MISSING_ID',
            message: 'dialog_id or group_id is required',
        });
        return;
    }

    if (dialog_id && group_id) {
        socket.emit('markMessagesAsRead_failed', {
            errorCode: 'INVALID_INPUT',
            message: 'Specify either dialog_id or group_id, not both',
        });
        return;
    }

    if ((dialog_id && !isValidUUID(dialog_id)) || (group_id && !isValidUUID(group_id))) {
        socket.emit('markMessagesAsRead_failed', {
            errorCode: 'INVALID_ID',
            message: 'Invalid dialog or group ID format',
        });
        return;
    }

    const conversationType = dialog_id ? 'dialog' : 'group';
    const conversationId = dialog_id || group_id!;
    const room = conversationType === 'dialog' ? `${ROOM_PREFIXES.DIALOG}${conversationId}` : `${ROOM_PREFIXES.GROUP}${conversationId}`;

    try {
        const isParticipant = conversationType === 'dialog'
            ? await knex('dialog_participants').where({ dialog_id: conversationId, user_id: userId }).first()
            : await knex('group_participants').where({ group_id: conversationId, user_id: userId }).first();

        if (!isParticipant) {
            socket.emit('markMessagesAsRead_failed', {
                errorCode: 'NOT_PARTICIPANT',
                message: `You are not a participant of this ${conversationType}`,
            });
            return;
        }

        if (!message_ids.every(id => isValidUUID(id))) {
            socket.emit('markMessagesAsRead_failed', {
                errorCode: 'INVALID_MESSAGE_IDS',
                message: 'One or more message IDs have invalid format',
            });
            return;
        }

        const readEntries = message_ids.map((msgId) => ({
            message_id: msgId,
            user_id: userId,
            read_at: new Date(),
        }));
        await knex('message_reads')
            .insert(readEntries)
            .onConflict(['message_id', 'user_id'])
            .ignore();

        const userDetails = await getCachedUserDetails(userId);
        const payload = {
            dialog_id: dialog_id || undefined,
            group_id: group_id || undefined,
            user_id: userId,
            avatarUrl: userDetails.avatarPath,
            message_ids,
            read_at: new Date().toISOString(),
        };

        emitToRoom(room, 'messagesRead', payload);
        console.log(JSON.stringify({
            event: 'markMessagesAsRead',
            userId,
            conversationType,
            conversationId,
            messageIds: message_ids,
            status: 'success',
        }));
    } catch (error: any) {
        console.error(JSON.stringify({
            event: 'markMessagesAsRead',
            userId,
            conversationType,
            conversationId,
            errorCode: error.code || 'DB_ERROR',
            errorMessage: error.message || 'Failed to mark messages as read',
        }));
        socket.emit('markMessagesAsRead_failed', {
            errorCode: error.code || 'DB_ERROR',
            message: 'Failed to mark messages as read',
        });
    }
}

export function handleTyping(socket: Socket, { dialog_id, group_id, user_id }: TypingData, isTyping: boolean): void {
    const authenticatedUserId = userSockets.get(socket.id);
    if (!authenticatedUserId || authenticatedUserId !== user_id) {
        console.warn(JSON.stringify({
            event: isTyping ? 'startTyping' : 'stopTyping',
            socketId: socket.id,
            userId: user_id,
            status: 'failed',
            reason: 'Auth mismatch',
        }));
        return;
    }

    if (!dialog_id && !group_id) {
        console.warn(JSON.stringify({
            event: isTyping ? 'startTyping' : 'stopTyping',
            userId: user_id,
            status: 'failed',
            reason: 'Missing dialog_id or group_id',
        }));
        return;
    }

    if (dialog_id && group_id) {
        console.warn(JSON.stringify({
            event: isTyping ? 'startTyping' : 'stopTyping',
            userId: user_id,
            status: 'failed',
            reason: 'Both dialog_id and group_id specified',
        }));
        return;
    }

    if ((dialog_id && !isValidUUID(dialog_id)) || (group_id && !isValidUUID(group_id))) {
        console.warn(JSON.stringify({
            event: isTyping ? 'startTyping' : 'stopTyping',
            userId: user_id,
            status: 'failed',
            reason: 'Invalid dialog or group ID format',
        }));
        return;
    }

    const conversationType = dialog_id ? 'dialog' : 'group';
    const conversationId = dialog_id || group_id!;
    const room = conversationType === 'dialog' ? `${ROOM_PREFIXES.DIALOG}${conversationId}` : `${ROOM_PREFIXES.GROUP}${conversationId}`;

    const event = isTyping ? 'user_typing' : 'user_stopped_typing';
    socket.to(room).emit(event, { dialog_id, group_id, user_id });
    console.log(JSON.stringify({
        event: isTyping ? 'startTyping' : 'stopTyping',
        userId: user_id,
        conversationType,
        conversationId,
        status: 'success',
    }));
}