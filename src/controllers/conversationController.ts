import { Request, Response } from "express";
import knex from '../lib/knex'; 
import type { Knex as KnexType } from 'knex'; 
import * as socketService from '../services/socketService';
import { 
    isUserParticipant, 
    fetchPinnedMessageIds,
    fetchAllParticipantsByConversationIdForMessages
} from '../lib/dbHelpers'; 

const fetchFullConversationDetails = async (conversationId: string, currentUserId?: string): Promise<any | null> => {
    console.log(`Fetching full details for conversation: ${conversationId}`);
    
    try {
        const participantsInfoCteQuery = knex('conversation_participants as cp')
            .select(
                'cp.conversation_id',
                knex.raw(`json_agg(
                    json_build_object(
                        'user_id', u.id,
                        'username', u.username,
                        'email', u.email,
                        'is_online', u.is_online,
                        'avatarPath', ua.file_path
                    ) ORDER BY u.username
                ) as participants`)
            )
            .join('users as u', 'u.id', 'cp.user_id')
            .leftJoin('user_avatars as ua', 'u.id', 'ua.user_id')
            .where('cp.conversation_id', conversationId)
            .groupBy('cp.conversation_id');
        const adminDetailsCteQuery = knex('users as u')
            .select(
                'u.id as admin_id',
                'u.username as admin_username',
                'ua.file_path as adminAvatarPath'
            )
            .leftJoin('user_avatars as ua', 'u.id', 'ua.user_id')
            .whereIn('u.id', function() {
                this.select('admin_id').from('conversations').where('id', conversationId);
            });
        const conversation = await knex('conversations as c')
            .with('participants_info_cte', participantsInfoCteQuery)
            .with('admin_details_cte', adminDetailsCteQuery)
            .select(
                'c.id as conversation_id',
                knex.raw(`
                CASE
                    WHEN c.is_group_chat THEN c.name
                    WHEN NOT c.is_group_chat AND ? IS NOT NULL THEN (
                        SELECT u_dialog.username 
                        FROM conversation_participants cp_dialog 
                        JOIN users u_dialog ON u_dialog.id = cp_dialog.user_id 
                        WHERE cp_dialog.conversation_id = c.id AND cp_dialog.user_id != ? LIMIT 1
                    )
                    ELSE c.name
                END AS conversation_name 
                `, [currentUserId, currentUserId]),
                'c.is_group_chat',
                'c.name as group_name',
                'c.avatar_path as groupAvatarPath',
                'adc.admin_id',
                'adc.admin_username',
                'adc.adminAvatarPath',
                knex.raw('COALESCE(pic.participants, \'[]\'::json) as participants'),
                knex.raw('c.created_at::text AS conversation_created_at'),
                knex.raw(`(
                    SELECT COALESCE(array_agg(pm.message_id ORDER BY pm.pinned_at DESC), '{}'::uuid[]) 
                    FROM pinned_messages pm WHERE pm.conversation_id = c.id
                ) as pinned_message_ids`)
            )
            .leftJoin('participants_info_cte as pic', 'pic.conversation_id', 'c.id')
            .leftJoin('admin_details_cte as adc', knex.raw('true'))
            .where('c.id', conversationId)
            .first();
        if (!conversation) { 
            console.warn(`Conversation ${conversationId} not found by fetchFullConversationDetails`);
            return null; 
        }
        const pinnedIds = await fetchPinnedMessageIds(conversationId);
        return {
            ...conversation,
            pinned_message_ids: pinnedIds,
            participants: conversation.participants || []
        };
    } catch (error) {
        console.error(`Error fetching full conversation details for ${conversationId}:`, error);
        return null;
    }
};

export const fetchAllConversationsByUserId = async (req: Request, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
        console.warn("Attempt to fetch conversations without authentication.");
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }

    console.log(`Получение чатов для пользователя: ${userId}`);

    try {
        // Define CTEs as separate Knex query builders
        const dialogNamesCte = knex('conversations as c')
            .select(
                'c.id as conversation_id',
                knex.raw(`
                    CASE
                        WHEN c.is_group_chat THEN c.name
                        ELSE (
                            SELECT u.username
                            FROM conversation_participants cp2
                            JOIN users u ON u.id = cp2.user_id
                            WHERE cp2.conversation_id = c.id
                            AND cp2.user_id != ? 
                            LIMIT 1
                        )
                    END AS conversation_name 
                `, [userId])
            );

        const lastMessagesCte = knex('messages as m')
            .distinctOn('m.conversation_id')
            .select(
                'm.conversation_id',
                'm.content',
                'm.created_at',
                'm.sender_id',
                'm.sender_username',
                'sender_avatar.file_path as sender_avatar_path',
                'm.is_forwarded',
                'm.forwarded_from_username'
            )
            .leftJoin('user_avatars as sender_avatar', 'm.sender_id', 'sender_avatar.user_id')
            .orderBy('m.conversation_id')
            .orderBy('m.created_at', 'desc');

        const participantsInfoCte = knex('conversation_participants as cp')
            .select(
                'cp.conversation_id',
                knex.raw(`json_agg(
                    json_build_object(
                        'user_id', u.id,
                        'username', u.username,
                        'email', u.email,
                        'is_online', u.is_online,
                        'avatarPath', ua.file_path 
                    ) ORDER BY u.username
                ) as participants`)
            )
            .join('users as u', 'u.id', 'cp.user_id')
            .leftJoin('user_avatars as ua', 'u.id', 'ua.user_id')
            .groupBy('cp.conversation_id');

        const unreadCountsCte = knex('messages as m')
            .select('m.conversation_id', knex.raw('COUNT(m.id)::int as unread_count'))
            .join('conversation_participants as cp', function(this: KnexType.JoinClause) {
                this.on('m.conversation_id', '=', 'cp.conversation_id').andOnVal('cp.user_id', '=', userId);
            })
            .leftJoin('message_reads as mr', function(this: KnexType.JoinClause) {
                this.on('mr.message_id', '=', 'm.id').andOn('mr.user_id', '=', 'cp.user_id');
            })
            .where('m.sender_id', '!=', userId)
            .whereNull('mr.message_id')
            .groupBy('m.conversation_id');
        
        const pinnedIdsCte = knex('pinned_messages')
            .select('conversation_id', knex.raw('array_agg(message_id ORDER BY pinned_at DESC) as pinned_message_ids'))
            .groupBy('conversation_id');

        // Main query using the CTEs
        const conversations = await knex('conversations as c')
             .with('dialog_names_cte', dialogNamesCte)
             .with('last_messages_cte', lastMessagesCte)
             .with('participants_info_cte', participantsInfoCte)
             .with('unread_counts_cte', unreadCountsCte)
             .with('pinned_ids_cte', pinnedIdsCte)
            .select(
                'c.id as conversation_id',
                'dnc.conversation_name',
                'c.is_group_chat',
                'c.name as group_name',
                'c.avatar_path as groupAvatarPath',
                'admin_user.username as admin_name',
                'admin_avatar.file_path as adminAvatarPath',
                'c.admin_id',
                'lmc.content as last_message',
                knex.raw('lmc.created_at::text as last_message_time'),
                'lmc.sender_id as last_message_sender_id',
                'lmc.sender_avatar_path as lastMessageSenderAvatarPath',
                knex.raw(`
                    CASE
                        WHEN lmc.is_forwarded THEN '[Переслано от ' || COALESCE(lmc.forwarded_from_username, 'Unknown') || '] ' || lmc.content
                        ELSE lmc.content
                    END AS last_message_content_preview
                `),
                'lmc.sender_username as last_message_sender_username',
                'lmc.is_forwarded as last_message_is_forwarded',
                'lmc.forwarded_from_username as last_message_forwarded_from',
                knex.raw('COALESCE(ucc.unread_count, 0) as unread_count'),
                'cp.is_muted',
                knex.raw('cp.last_read_timestamp::text as last_read_timestamp'),
                knex.raw('COALESCE(picte.pinned_message_ids, \'{}\'::uuid[]) as pinned_message_ids'),
                knex.raw('COALESCE(pinfc.participants, \'[]\'::json) as participants'),
                knex.raw('c.created_at::text as conversation_created_at')
            )
            .join('conversation_participants as cp', function(this: KnexType.JoinClause) {
                this.on('cp.conversation_id', '=', 'c.id').andOnVal('cp.user_id', '=', userId);
            })
            .join('dialog_names_cte as dnc', 'dnc.conversation_id', 'c.id') 
            .leftJoin('users as admin_user', 'admin_user.id', 'c.admin_id')
            .leftJoin('user_avatars as admin_avatar', 'admin_avatar.user_id', 'admin_user.id')
            .leftJoin('last_messages_cte as lmc', 'lmc.conversation_id', 'c.id') 
            .leftJoin('unread_counts_cte as ucc', 'ucc.conversation_id', 'c.id') 
            .leftJoin('participants_info_cte as pinfc', 'pinfc.conversation_id', 'c.id')
            .leftJoin('pinned_ids_cte as picte', 'picte.conversation_id', 'c.id') 
            .orderByRaw('lmc.created_at DESC NULLS LAST');

        const formattedResults = conversations.map(row => ({
            ...row,
            participants: row.participants || [], 
            pinned_message_ids: Array.isArray(row.pinned_message_ids) ? row.pinned_message_ids : [],
        }));

        res.json(formattedResults);
    } catch (error) {
        console.error('Ошибка при получении списка чатов:', error);
        res.status(500).json({ error: 'Не удалось получить список чатов' });
    }
};

export const createDialog = async (req: Request, res: Response): Promise<any> => {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
    }
    const { contact_id } = req.body;
    if (!contact_id) {
        return res.status(400).json({ error: 'Contact ID is required' });
    }
    if (userId === contact_id) {
        return res.status(400).json({ error: 'Cannot create dialog with yourself' });
    }

    try {
        // Check if dialog already exists between these two users
        const existingDialog = await knex('conversations as c')
            .where('c.is_group_chat', false)
            .whereIn('c.id', function(this: KnexType.QueryBuilder) {
                this.select('cp1.conversation_id')
                    .from('conversation_participants as cp1')
                    .join('conversation_participants as cp2', 'cp1.conversation_id', 'cp2.conversation_id')
                    .where('cp1.user_id', userId)
                    .andWhere('cp2.user_id', contact_id);
            })
            .first();

        if (existingDialog) {
            console.log(`Dialog between ${userId} and ${contact_id} already exists (ID: ${existingDialog.id}).`);
            // Optionally fetch and return full details of existing dialog?
            return res.status(200).json({ conversation_id: existingDialog.id, message: 'Dialog already exists.' });
        }

        // Create new dialog using transaction
        const newConversation = await knex.transaction(async (trx) => {
            // Insert conversation
            const insertedConv = await trx('conversations')
                .insert({ name: 'dialog', is_group_chat: false, admin_id: userId })
                .returning('id');
            
            if (!insertedConv || insertedConv.length === 0) {
                 throw new Error('Failed to create conversation record.');
            }
            const conversation_id = insertedConv[0].id;

            // Insert participants
            await trx('conversation_participants').insert([
                { conversation_id, user_id: userId },
                { conversation_id, user_id: contact_id }
            ]);
            
            return { id: conversation_id }; // Return the new ID
        });

        // Fetch full details after creation to send via socket
        const fullNewConversation = await fetchFullConversationDetails(newConversation.id, userId);
        if (fullNewConversation) {
            // Emit to both participants
            socketService.emitToUser(userId, 'newConversation', fullNewConversation);
            socketService.emitToUser(contact_id, 'newConversation', fullNewConversation);
            console.log(`Emitted newConversation event for dialog ${newConversation.id} to users ${userId} and ${contact_id}`);
        }

        res.status(201).json({ conversation_id: newConversation.id });
        console.log(`Dialog created successfully between ${userId} and ${contact_id}. ID: ${newConversation.id}`);

    } catch (error: any) {
        console.error(`Error creating dialog between ${userId} and ${contact_id}:`, error);
        if (error.code === '23503') { // Foreign key violation (likely contact_id doesn't exist)
             return res.status(404).json({ error: 'Указанный пользователь для диалога не найден.' });
        } else if (error.code === '23505') { // Unique constraint violation (less likely here, maybe on participants?)
             return res.status(409).json({ error: 'Не удалось создать диалог из-за конфликта данных.' });
        }
        res.status(500).json({ error: 'Не удалось создать диалог' });
    }
};

export const createGroupChat = async (req: Request, res: Response): Promise<any> => {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
    }
    const { name, participant_ids = [] } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Group chat name is required.' });
    }
    if (!Array.isArray(participant_ids)) {
        return res.status(400).json({ error: 'participant_ids must be an array.' });
    }
    const uniqueParticipantsSet = new Set([userId, ...participant_ids.filter(id => typeof id === 'string')]);
    const uniqueParticipantsArray = Array.from(uniqueParticipantsSet); // Convert Set to Array

    console.log(`User ${userId} creating group chat "${name}" with participants: ${uniqueParticipantsArray.join(', ')}`);

    try {
        // Check if a group chat with this name already exists (optional, depends on requirements)
        // const existingChat = await knex('conversations')
        //     .where({ name: name.trim(), is_group_chat: true })
        //     .first();
        // if (existingChat) {
        //     return res.status(409).json({ error: 'Group chat with this name already exists.' });
        // }

        // Check if all participant IDs exist using the array
        const existingUsers = await knex('users').select('id').whereIn('id', uniqueParticipantsArray);
        if (existingUsers.length !== uniqueParticipantsArray.length) {
            const foundIds = new Set(existingUsers.map(u => u.id));
            const missingIds = uniqueParticipantsArray.filter(id => !foundIds.has(id));
            console.warn(`Cannot create group chat: Users not found - ${missingIds.join(', ')}`);
            return res.status(404).json({ error: `Не удалось создать чат: Пользователи не найдены: ${missingIds.join(', ')}` });
        }

        const newConversation = await knex.transaction(async (trx) => {
            const insertedConv = await trx('conversations')
                .insert({ name: name.trim(), is_group_chat: true, admin_id: userId })
                .returning('id');

            if (!insertedConv || insertedConv.length === 0) {
                 throw new Error('Failed to create group chat record.');
            }
            const conversation_id = insertedConv[0].id;

            // Use the array for mapping participants
            const participantObjects = uniqueParticipantsArray.map(pId => ({ 
                conversation_id, 
                user_id: pId 
            }));
            
            await trx('conversation_participants').insert(participantObjects);
            
            return { id: conversation_id };
        });

        // Fetch full details for socket event
        const fullNewConversation = await fetchFullConversationDetails(newConversation.id, userId);
        if (fullNewConversation) {
            // Emit to all participants using the array
            uniqueParticipantsArray.forEach(pId => {
                socketService.emitToUser(pId, 'newConversation', fullNewConversation);
            });
            console.log(`Emitted newConversation event for group ${newConversation.id} to ${uniqueParticipantsArray.length} users`);
        }

        res.status(201).json({ conversation_id: newConversation.id });
        console.log(`Group chat "${name}" (ID: ${newConversation.id}) created successfully by user ${userId}.`);

    } catch (error: any) {
        console.error(`Error creating group chat "${name}" by user ${userId}:`, error);
        if (error.code === '23505') { // Unique constraint violation (e.g., duplicate participant insert?)
             return res.status(409).json({ error: 'Не удалось создать чат из-за конфликта данных (возможно, дубликат участника).' });
        }
        res.status(500).json({ error: 'Не удалось создать групповой чат' });
    }
};

export const addParticipantToConversation = async (req: Request, res: Response): Promise<any> => {
    const requestingUserId = req.user?.id;
    if (!requestingUserId) {
        return res.status(401).json({ error: 'User not authenticated' });
    }
    const { conversation_id, participant_id } = req.body;
    if (!conversation_id || !participant_id) {
        return res.status(400).json({ error: 'conversation_id and participant_id are required' });
    }

    console.log(`User ${requestingUserId} attempting to add participant ${participant_id} to conversation ${conversation_id}`);

    try {
        // Check conversation exists and is a group chat
        const conversation = await knex('conversations')
            .select('admin_id', 'is_group_chat')
            .where('id', conversation_id)
            .first();

        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }
        if (!conversation.is_group_chat) {
            return res.status(400).json({ error: 'Cannot add participants to a dialog' });
        }
        
        // Check if requesting user is the admin or a participant (policy decision needed: only admin adds?)
        // For now, let's assume only admin can add
        if (conversation.admin_id !== requestingUserId) {
            // Alternative: check if requesting user is at least a participant
            // const isRequestingUserParticipant = await isUserParticipant(requestingUserId, conversation_id);
            // if (!isRequestingUserParticipant) { ... }
            return res.status(403).json({ error: 'Only the group admin can add participants' });
        }

        // Check if user to add exists
        const userExists = await knex('users').where('id', participant_id).first();
        if (!userExists) {
            return res.status(404).json({ error: 'User to add not found' });
        }
        
        // Check if participant already exists
        const participantExists = await isUserParticipant(participant_id, conversation_id);
        if (participantExists) {
             return res.status(409).json({ error: 'Participant already exists in this conversation' });
        }

        // Add participant
        await knex('conversation_participants')
            .insert({ conversation_id, user_id: participant_id });
        
        console.log(`Participant ${participant_id} added successfully to conversation ${conversation_id} by user ${requestingUserId}`);

        // Fetch updated conversation details for socket events
        const updatedDetails = await fetchFullConversationDetails(conversation_id, requestingUserId);

        if (updatedDetails) {
            // Emit conversationUpdated to all existing participants (including the adder)
            updatedDetails.participants.forEach((p: any) => {
                 if (p.user_id !== participant_id) { // Don't send full update to the newly added yet
                     socketService.emitToUser(p.user_id, 'conversationUpdated', updatedDetails);
                 }
            });
             // Emit newConversation to the newly added participant
            socketService.emitToUser(participant_id, 'newConversation', updatedDetails);
            console.log(`Emitted conversation events after adding participant ${participant_id} to ${conversation_id}`);
        } else {
            console.warn(`Could not fetch updated details for ${conversation_id} after adding participant.`);
        }

        res.status(200).json({ message: 'Participant added successfully' });

    } catch (error: any) {
        console.error(`Error adding participant ${participant_id} to conversation ${conversation_id} by user ${requestingUserId}:`, error);
        if (error.code === '23503') { // Foreign key violation (likely conversation_id or participant_id is invalid)
             return res.status(404).json({ error: 'Conversation or user not found.' });
        } else if (error.code === '23505') { // Unique constraint violation
             return res.status(409).json({ error: 'Participant already exists (database constraint).' });
        }
        res.status(500).json({ error: 'Failed to add participant' });
    }
};

export const removeParticipantFromConversation = async (req: Request, res: Response): Promise<any> => {
    const requestingUserId = req.user?.id;
    if (!requestingUserId) {
        return res.status(401).json({ error: 'User not authenticated' });
    }
    const { conversation_id, participant_id } = req.body;
    if (!conversation_id || !participant_id) {
        return res.status(400).json({ error: 'conversation_id and participant_id are required' });
    }
    if (requestingUserId === participant_id) {
         return res.status(400).json({ error: 'Cannot remove yourself using this method. Use leaveConversation instead.' });
    }

    console.log(`User ${requestingUserId} attempting to remove participant ${participant_id} from conversation ${conversation_id}`);

    try {
        // Check conversation exists and is a group chat
        const conversation = await knex('conversations')
            .select('admin_id', 'is_group_chat')
            .where('id', conversation_id)
            .first();

        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }
        if (!conversation.is_group_chat) {
            return res.status(400).json({ error: 'Cannot remove participants from a dialog' });
        }
        
        // Check permissions (only admin can remove others)
        if (conversation.admin_id !== requestingUserId) {
            return res.status(403).json({ error: 'Only the group admin can remove participants' });
        }
        
        // Remove participant
        const deleteResult = await knex('conversation_participants')
            .where({ conversation_id, user_id: participant_id })
            .del();

        if (deleteResult === 0) {
            return res.status(404).json({ error: 'Participant not found in this conversation' }); 
        }

        console.log(`Participant ${participant_id} removed successfully from conversation ${conversation_id} by admin ${requestingUserId}`);

        // Fetch updated conversation details for socket events
        const updatedDetails = await fetchFullConversationDetails(conversation_id, requestingUserId);

        if (updatedDetails) {
            // Emit conversationUpdated to remaining participants 
            updatedDetails.participants.forEach((p: any) => {
                 socketService.emitToUser(p.user_id, 'conversationUpdated', updatedDetails);
            });
            // Emit conversationRemoved to the removed participant
            socketService.emitToUser(participant_id, 'conversationRemoved', { conversationId: conversation_id }); 
            console.log(`Emitted conversation events after removing participant ${participant_id} from ${conversation_id}`);
        } else {
             console.warn(`Could not fetch updated details for ${conversation_id} after removing participant.`);
        }

        res.status(200).json({ message: 'Participant removed successfully' });

    } catch (error: any) {
        console.error(`Error removing participant ${participant_id} from conversation ${conversation_id} by user ${requestingUserId}:`, error);
         if (error.code === '22P02') { // Invalid UUID format
            return res.status(400).json({ error: 'Invalid ID format for conversation or participant.' });
        }
        res.status(500).json({ error: 'Failed to remove participant' });
    }
};

export const updateConversationName = async (req: Request, res: Response): Promise<any> => {
    const requestingUserId = req.user?.id;
    if (!requestingUserId) {
        return res.status(401).json({ error: 'User not authenticated' });
    }
    const { conversation_id, conversation_name } = req.body;
    if (!conversation_id || !conversation_name || typeof conversation_name !== 'string' || conversation_name.trim().length === 0) {
        return res.status(400).json({ error: 'conversation_id and a non-empty conversation_name are required' });
    }

    console.log(`User ${requestingUserId} attempting to rename conversation ${conversation_id} to "${conversation_name.trim()}"`);

    try {
        // Check conversation exists and is a group chat
        const conversation = await knex('conversations')
            .select('admin_id', 'is_group_chat')
            .where('id', conversation_id)
            .first();

        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }
        if (!conversation.is_group_chat) {
            return res.status(400).json({ error: 'Cannot rename a dialog' });
        }
        
        // Check permissions (only admin can rename)
        if (conversation.admin_id !== requestingUserId) {
            return res.status(403).json({ error: 'Only the group admin can rename the conversation' });
        }

        // Update name
        const updateResult = await knex('conversations')
            .where('id', conversation_id)
            .update({ name: conversation_name.trim() }, ['name']); // Use array for returning
          
        if (updateResult.length === 0) {
             // Should not happen if checks above passed
             console.error('Failed to update conversation name after checks');
             return res.status(500).json({ error: 'Failed to update conversation name' });
        }

        const newName = updateResult[0].name;
        console.log(`Conversation ${conversation_id} renamed successfully to "${newName}" by user ${requestingUserId}`);

        // Fetch updated details and emit
        const updatedDetails = await fetchFullConversationDetails(conversation_id, requestingUserId);
        if (updatedDetails) {
            socketService.emitToRoom(conversation_id, 'conversationUpdated', updatedDetails);
            console.log(`Emitted conversationUpdated after rename to room ${conversation_id}`);
        } else {
             console.warn(`Could not fetch updated details for ${conversation_id} after rename.`);
        }

        res.status(200).json({ conversation_name: newName });

    } catch (error: any) {
        console.error(`Error updating conversation name for ${conversation_id} by user ${requestingUserId}:`, error);
        if (error.code === '23505') { // Unique constraint violation (if name needs to be unique)
             return res.status(409).json({ error: 'A group chat with this name might already exist.' });
        } else if (error.code === '22P02') {
             return res.status(400).json({ error: 'Invalid ID format for conversation.' });
        }
        res.status(500).json({ error: 'Failed to update conversation name' });
    }
};

export const fetchAllParticipantsByConversationId = async (req: Request, res: Response): Promise<any> => {
    const { conversationId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
    }
    if (!conversationId) {
        return res.status(400).json({ error: 'Conversation ID is required' });
    }

    try {
        const isMember = await isUserParticipant(userId, conversationId);
        if (!isMember) {
            return res.status(403).json({ error: 'User is not a participant of this conversation' });
        }

        const participants = await knex('conversation_participants as cp')
            .select(
                'u.id as user_id',
                'u.username',
                'u.email',
                'u.is_online',
                'ua.file_path as avatarPath'
            )
            .join('users as u', 'u.id', 'cp.user_id')
            .leftJoin('user_avatars as ua', 'u.id', 'ua.user_id')
            .where('cp.conversation_id', conversationId)
            .orderBy('u.username');
        
        res.json(participants);

    } catch (error: any) {
        console.error(`Error fetching participants for conversation ${conversationId}:`, error);
        if (error.code === '22P02') { // invalid input for type uuid
            return res.status(400).json({ error: 'Invalid Conversation ID format.' });
        }
        res.status(500).json({ error: 'Failed to fetch participants' });
    }
};

export const markConversationReadUnread = async (req: Request, res: Response): Promise<void> => {
    const { conversationId, mark_as_unread } = req.body; 
    const userId = req.user?.id;

    if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
    }
    if (!conversationId) {
        res.status(400).json({ error: 'Conversation ID is required' });
        return;
    }
    if (typeof mark_as_unread !== 'boolean') {
        res.status(400).json({ error: 'mark_as_unread parameter must be boolean' });
        return;
    }

    console.log(`User ${userId} marking conversation ${conversationId} as ${mark_as_unread ? 'unread' : 'read'}`);

    try {
        const isMember = await isUserParticipant(userId, conversationId); 
        if (!isMember) {
            res.status(404).json({ error: 'Чат не найден или вы не являетесь участником' });
            return;
        }

        if (mark_as_unread === false) { 
            const messagesToRead = await knex('messages')
                .select('id') 
                .where('conversation_id', conversationId)
                .andWhere('sender_id', '!=', userId);
            const messageIdsToRead = messagesToRead.map(row => row.id);

            if (messageIdsToRead.length > 0) {
                const values = messageIdsToRead.map(id => ({ message_id: id, user_id: userId, read_at: knex.fn.now() }));
                await knex('message_reads')
                    .insert(values)
                    .onConflict(['message_id', 'user_id'])
                    .ignore();
                 console.log(`Marked ${messageIdsToRead.length} messages as read for user ${userId} in conv ${conversationId}`);
            }
        } else { 
            const deleteResult = await knex('message_reads')
                .where('user_id', userId)
                .andWhere(function(this: KnexType.QueryBuilder) { 
                    this.whereIn('message_id', function(this: KnexType.QueryBuilder) { 
                        this.select('id').from('messages').where('conversation_id', conversationId);
                    });
                })
                .del();
             console.log(`Marked conversation ${conversationId} as unread for user ${userId}. Deleted ${deleteResult} read records.`);
        }

        // Recalculate unread count
        const unreadCountResult = await knex('messages as m')
             .leftJoin('message_reads as mr', function(this: KnexType.JoinClause) { 
                 this.on('mr.message_id', '=', 'm.id').andOnVal('mr.user_id', '=', userId);
             })
             .where('m.conversation_id', conversationId)
             .andWhere('m.sender_id', '!=', userId)
             .whereNull('mr.message_id')
             .count('m.id as count')
             .first();
        
        const actualUnreadCount = unreadCountResult ? Number(unreadCountResult.count) : 0;

        const muteStatusResult = await knex('conversation_participants')
            .select('is_muted')
            .where('conversation_id', conversationId)
            .andWhere('user_id', userId)
            .first();
        const currentMuteStatus = muteStatusResult?.is_muted ?? false;

        const eventPayload = {
            conversation_id: conversationId,
            unread_count: actualUnreadCount,
             is_muted: currentMuteStatus
        };
        socketService.emitToUser(userId, 'conversationUpdated', eventPayload);

        res.status(200).json({
            message: `Conversation marked as ${mark_as_unread ? 'unread' : 'read'}`, 
            unread_count: actualUnreadCount 
        });
        return;

    } catch (error: any) {
        console.error(`Error marking conversation ${conversationId} read/unread for user ${userId}:`, error);
        if (error.code === '22P02') {
            res.status(400).json({ error: 'Invalid Conversation ID format.' });
            return;
        }
        res.status(500).json({ error: 'Ошибка сервера при обновлении статуса прочтения чата' });
        return;
    }
};

export const muteConversation = async (req: Request, res: Response): Promise<void> => {
    const { conversationId, is_muted } = req.body; 
    const userId = req.user?.id;

    if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
    }
    if (!conversationId) {
        res.status(400).json({ error: 'Conversation ID is required' });
        return;
    }
    if (typeof is_muted !== 'boolean') {
        res.status(400).json({ error: 'is_muted parameter must be boolean' });
        return;
    }

    try {
        const updateResult = await knex('conversation_participants')
            .where('conversation_id', conversationId)
            .andWhere('user_id', userId)
            .update({ is_muted: is_muted }, ['is_muted']); 

        if (updateResult.length === 0) {
            const convExists = await knex('conversations').where('id', conversationId).first();
            if (!convExists) {
                res.status(404).json({ error: 'Чат не найден.' });
                return;
            } else {
                console.warn(`User ${userId} tried to mute conv ${conversationId} but is not a participant or update failed.`);
                res.status(404).json({ error: 'Чат не найден или вы не являетесь участником' });
                return;
            }
        }

        const newMuteStatus = updateResult[0].is_muted;

        const unreadCountResult = await knex('messages as m')
             .leftJoin('message_reads as mr', function(this: KnexType.JoinClause) { 
                 this.on('mr.message_id', '=', 'm.id').andOnVal('mr.user_id', '=', userId);
             })
             .where('m.conversation_id', conversationId)
             .andWhere('m.sender_id', '!=', userId)
             .whereNull('mr.message_id')
             .count('m.id as count')
             .first();
        const actualUnreadCount = unreadCountResult ? Number(unreadCountResult.count) : 0;

        const eventPayload = {
            conversation_id: conversationId,
            unread_count: actualUnreadCount,
            is_muted: newMuteStatus
        };
        socketService.emitToUser(userId, 'conversationUpdated', eventPayload);

        res.status(200).json({ message: `Conversation ${newMuteStatus ? 'muted' : 'unmuted'}`, is_muted: newMuteStatus });
        return;
    } catch (error: any) {
        console.error(`Error muting/unmuting conversation ${conversationId} for user ${userId}:`, error);
        if (error.code === '22P02') {
            res.status(400).json({ error: 'Invalid Conversation ID format.' });
            return;
        }
        res.status(500).json({ error: 'Ошибка сервера при изменении статуса mute чата' });
        return;
    }
};

export const leaveOrDeleteConversation = async (req: Request, res: Response): Promise<void> => {
    const { conversationId } = req.body;
    const userId = req.user?.id;

    if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
    }
    if (!conversationId) {
        res.status(400).json({ error: 'Conversation ID is required' });
        return;
    }

    try {
         const convInfo: any = await knex('conversations as c')
             .select('c.id', 'c.is_group_chat', 'c.admin_id',
                 knex.raw('(SELECT COUNT(*) FROM conversation_participants cp_count WHERE cp_count.conversation_id = c.id)::int as participant_count'),
                 knex.raw('EXISTS (SELECT 1 FROM conversation_participants cp_check WHERE cp_check.conversation_id = c.id AND cp_check.user_id = ?) as is_participant', [userId])
             )
             .where('c.id', conversationId)
             .first();

         if (!convInfo) {
             console.warn(`Conversation ${conversationId} not found for leave/delete.`);
             res.status(404).json({ error: 'Чат не найден' });
             return;
         }

         const participant_count = Number(convInfo.participant_count);
         const { is_group_chat, admin_id, is_participant } = convInfo;

         if (!is_participant) {
             console.warn(`User ${userId} tried to leave/delete conversation ${conversationId} but is not a participant.`);
             res.status(403).json({ error: 'Вы не являетесь участником этого чата' });
             return;
         }

         if (is_group_chat) {
              await knex.transaction(async (trx) => {
                 const deletedCount = await trx('conversation_participants')
                     .where({ conversation_id: conversationId, user_id: userId })
                     .del();
                 
                 if (deletedCount === 0) {
                     throw new Error('Failed to remove participant record during leave.');
                 }
                 console.log(`User ${userId} left group ${conversationId}.`);

                 const remainingParticipants = participant_count - 1;
                 
                 if (remainingParticipants === 0) {
                     await trx('conversations').where('id', conversationId).del();
                     console.log(`Group ${conversationId} deleted as last participant left.`);
                 } else if (userId === admin_id) {
                     const newAdmin = await trx('conversation_participants')
                         .select('user_id')
                         .where('conversation_id', conversationId)
                         .orderBy('joined_at', 'asc')
                         .first();
                     if (newAdmin) {
                         await trx('conversations')
                             .where('id', conversationId)
                             .update({ admin_id: newAdmin.user_id });
                         console.log(`Admin ${userId} left group ${conversationId}, new admin assigned: ${newAdmin.user_id}`);
                     } else {
                         console.error(`Could not find a new admin for group ${conversationId} after admin ${userId} left, although remaining count was ${remainingParticipants}. Deleting group.`);
                         await trx('conversations').where('id', conversationId).del();
                     }
                 }
             });
             
             const updatedDetails = await fetchFullConversationDetails(conversationId, userId);
             if (updatedDetails) { 
                 updatedDetails.participants.forEach((p: any) => {
                     socketService.emitToUser(p.user_id, 'conversationUpdated', updatedDetails);
                 });
                 console.log(`Emitted conversationUpdated to remaining participants of group ${conversationId}`);
             } else {
                  console.log(`Group ${conversationId} was deleted after user left.`);
             }
             socketService.emitToUser(userId, 'conversationRemoved', { conversationId });

             res.status(200).json({ message: 'Вы успешно покинули группу.' });
             return;

         } else { 
             const otherParticipant = await knex('conversation_participants')
                 .select('user_id')
                 .where('conversation_id', conversationId)
                 .andWhere('user_id', '!=', userId)
                 .first();

             const deleteResult = await knex('conversations').where('id', conversationId).del(); 
             
             if (deleteResult > 0) {
                 console.log(`User ${userId} deleted dialog ${conversationId}.`);
                 socketService.emitToUser(userId, 'conversationRemoved', { conversationId });
                 if (otherParticipant) {
                     socketService.emitToUser(otherParticipant.user_id, 'conversationRemoved', { conversationId });
                 }
                 res.status(200).json({ message: 'Диалог успешно удален.' });
                 return;
             } else {
                 console.warn(`Dialog ${conversationId} not found for deletion, though participant check passed earlier.`);
                 res.status(404).json({ error: 'Не удалось найти диалог для удаления.' });
                 return;
             }
         }

    } catch (error: any) {
        console.error(`Error leaving/deleting conversation ${conversationId} for user ${userId}:`, error);
        if (error.code === '22P02') {
            res.status(400).json({ error: 'Invalid Conversation ID format.' });
            return;
        }
        res.status(500).json({ error: 'Ошибка сервера при выходе/удалении чата' });
        return;
    }
};

export const togglePinMessage = async (req: Request, res: Response): Promise<void> => {
    const { conversationId, messageId } = req.body;
    let userId: string;

    if (req.user) {
        userId = req.user.id;
    } else {
        res.status(401).json({ error: 'Пользователь не авторизован' }); 
        return; 
    }
    if (!conversationId || !messageId) {
        res.status(400).json({ error: 'conversationId и messageId обязательны' });
        return;
    }

    try {
        const isMember = await isUserParticipant(userId, conversationId); 
        if (!isMember) {
           res.status(403).json({ error: 'Вы не можете закреплять сообщения в этом чате' });
           return; 
        }

        const messageExists = await knex('messages')
            .where({ id: messageId, conversation_id: conversationId })
            .first();
        if (!messageExists) {
            console.warn(`Message ${messageId} not found in conversation ${conversationId}.`);
            res.status(404).json({ error: 'Сообщение не найдено в этом чате' });
            return; 
        }

        const existingPin = await knex('pinned_messages')
            .where({ conversation_id: conversationId, message_id: messageId })
            .first();

        let message: string;
        if (existingPin) {
            await knex('pinned_messages')
                .where({ conversation_id: conversationId, message_id: messageId })
                .del();
            message = 'Сообщение откреплено';
            console.log(`Message ${messageId} unpinned by user ${userId} in conversation ${conversationId}`);
        } else {
            await knex('pinned_messages')
                .insert({ 
                    conversation_id: conversationId, 
                    message_id: messageId, 
                    pinned_by_user_id: userId, 
                    pinned_at: knex.fn.now() 
                });
            message = 'Сообщение закреплено';
             console.log(`Message ${messageId} pinned by user ${userId} in conversation ${conversationId}`);
        }

        const updatedPinnedIds = await fetchPinnedMessageIds(conversationId);

        socketService.emitToRoom(conversationId, 'pinnedMessagesUpdated', { 
            conversationId: conversationId, 
            pinnedMessageIds: updatedPinnedIds 
        });

        res.status(200).json({
            message: message, 
            pinnedMessageIds: updatedPinnedIds 
        });
        return; 

    } catch (error: any) {
        console.error(`Error toggling pin for message ${messageId} in conversation ${conversationId} by user ${userId}:`, error);
         if (error.code === '22P02') {
             res.status(400).json({ error: 'Invalid ID format for conversation or message.' });
             return;
        }
        res.status(500).json({ error: 'Ошибка сервера при закреплении/откреплении сообщения' });
        return; 
    }
};
