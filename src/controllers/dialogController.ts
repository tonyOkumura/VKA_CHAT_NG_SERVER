import { Request, Response } from 'express';
import knex from '../lib/knex';
import { emitToUser, emitToRoom } from '../services/socketService';

const fetchFullDialogDetails = async (dialogId: string, currentUserId?: string): Promise<any> => {
  console.log(`Fetching full details for dialog: ${dialogId}`);

  try {
    const dialog = await knex('dialogs as d')
      .select(
        'd.id as dialog_id',
        'd.user1_id',
        'd.user2_id',
        'u1.username as user1_username',
        'u1.avatar_path as user1_avatarPath',
        'u1.is_online as user1_isOnline',
        'u2.username as user2_username',
        'u2.avatar_path as user2_avatarPath',
        'u2.is_online as user2_isOnline',
        'd.created_at'
      )
      .join('users as u1', 'u1.id', 'd.user1_id')
      .join('users as u2', 'u2.id', 'd.user2_id')
      .where('d.id', dialogId)
      .first();

    if (!dialog) {
      console.warn(`Dialog ${dialogId} not found`);
      return null;
    }

    const participants = [
      {
        user_id: dialog.user1_id,
        username: dialog.user1_username,
        avatarPath: dialog.user1_avatarPath,
        is_online: dialog.user1_isOnline,
      },
      {
        user_id: dialog.user2_id,
        username: dialog.user2_username,
        avatarPath: dialog.user2_avatarPath,
        is_online: dialog.user2_isOnline,
      },
    ];

    const dialogName = currentUserId === dialog.user1_id ? dialog.user2_username : dialog.user1_username;

    return {
      dialog_id: dialog.id,
      conversation_name: dialogName,
      is_group: false,
      participants,
      created_at: dialog.created_at,
    };
  } catch (error) {
    console.error(`Error fetching dialog details for ${dialogId}:`, error);
    return null;
  }
};

export const fetchAllDialogsByUserId = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    console.warn('Attempt to fetch dialogs without authentication');
    res.status(401).json({ error: 'Пользователь не авторизован' });
    return;
  }

  console.log(`Fetching dialogs for user: ${userId}`);

  try {
    const lastMessagesCte = knex('messages as m')
      .distinctOn('m.dialog_id')
      .select(
        'm.dialog_id',
        'm.content',
        'm.created_at',
        'm.sender_id',
        'm.sender_username',
        'm.is_forwarded',
        'm.forwarded_from_username'
      )
      .whereNotNull('m.dialog_id')
      .orderBy('m.dialog_id')
      .orderBy('m.created_at', 'desc');

    const unreadCountsCte = knex('messages as m')
      .select('m.dialog_id', knex.raw('COUNT(m.id)::int as unread_count'))
      .join('dialog_participants as dp', 'dp.dialog_id', 'm.dialog_id')
      .leftJoin('message_reads as mr', function () {
        this.on('mr.message_id', '=', 'm.id').andOn('mr.user_id', '=', knex.raw('?', [userId]));
      })
      .where('dp.user_id', userId)
      .where('m.sender_id', '!=', userId)
      .whereNull('mr.message_id')
      .groupBy('m.dialog_id');

    const dialogs = await knex('dialogs as d')
      .with('last_messages_cte', lastMessagesCte)
      .with('unread_counts_cte', unreadCountsCte)
      .select(
        'd.id as dialog_id',
        'u.username as conversation_name',
        'u.avatar_path as conversation_avatarPath',
        'u.is_online as conversation_isOnline',
        'lmc.content as last_message',
        'lmc.created_at as last_message_time',
        'lmc.sender_id as last_message_sender_id',
        'lmc.sender_username as last_message_sender_username',
        'lmc.is_forwarded as last_message_is_forwarded',
        'lmc.forwarded_from_username as last_message_forwarded_from',
        'dp.is_muted',
        'dp.last_read_timestamp',
        'dp.notification_settings',
        'd.created_at as conversation_created_at',
        knex.raw('COALESCE(ucc.unread_count, 0) as unread_count')
      )
      .join('dialog_participants as dp', 'dp.dialog_id', 'd.id')
      .join('users as u', function () {
        this.on('u.id', '=', knex.raw('CASE WHEN d.user1_id = ? THEN d.user2_id ELSE d.user1_id END', [userId]));
      })
      .leftJoin('last_messages_cte as lmc', 'lmc.dialog_id', 'd.id')
      .leftJoin('unread_counts_cte as ucc', 'ucc.dialog_id', 'd.id')
      .where('dp.user_id', userId)
      .orderByRaw('lmc.created_at DESC NULLS LAST');

    const formattedResults = dialogs.map((row) => ({
      dialog_id: row.dialog_id,
      conversation_name: row.conversation_name,
      is_group: false,
      conversation_avatarPath: row.conversation_avatarPath,
      conversation_isOnline: row.conversation_isOnline,
      last_message: row.last_message,
      last_message_time: row.last_message_time,
      last_message_sender_id: row.last_message_sender_id,
      last_message_sender_username: row.last_message_sender_username,
      last_message_is_forwarded: row.last_message_is_forwarded,
      last_message_forwarded_from: row.last_message_forwarded_from,
      last_message_content_preview: row.last_message_is_forwarded
        ? `[Переслано от ${row.last_message_forwarded_from || 'Unknown'}] ${row.last_message}`
        : row.last_message,
      unread_count: row.unread_count,
      is_muted: row.is_muted,
      last_read_timestamp: row.last_read_timestamp,
      notification_settings: row.notification_settings,
      conversation_created_at: row.conversation_created_at,
    }));

    res.json(formattedResults);
  } catch (error) {
    console.error('Ошибка при получении списка диалогов:', error);
    res.status(500).json({ error: 'Не удалось получить список диалогов' });
  }
};

export const createDialog = async (req: Request, res: Response): Promise<any> => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Пользователь не авторизован' });
  }
  const { contact_id } = req.body;
  if (!contact_id) {
    return res.status(400).json({ error: 'Contact ID обязателен' });
  }
  if (userId === contact_id) {
    return res.status(400).json({ error: 'Нельзя создать диалог с самим собой' });
  }

  try {
    const existingDialog = await knex('dialogs')
      .where(function () {
        this.where({ user1_id: userId, user2_id: contact_id }).orWhere({
          user1_id: contact_id,
          user2_id: userId,
        });
      })
      .first();

    if (existingDialog) {
      console.log(`Dialog between ${userId} and ${contact_id} already exists (ID: ${existingDialog.id})`);
      return res.status(200).json({ dialog_id: existingDialog.id, message: 'Диалог уже существует' });
    }

    const newDialog = await knex.transaction(async (trx) => {
      const [insertedDialog] = await trx('dialogs')
        .insert({ user1_id: userId, user2_id: contact_id })
        .returning(['id']);

      await trx('dialog_participants').insert([
        { dialog_id: insertedDialog.id, user_id: userId },
        { dialog_id: insertedDialog.id, user_id: contact_id },
      ]);

      return insertedDialog;
    });

    const fullDialogDetails = await fetchFullDialogDetails(newDialog.id, userId);
    if (fullDialogDetails) {
      emitToUser(userId, 'newDialog', fullDialogDetails);
      emitToUser(contact_id, 'newDialog', fullDialogDetails);
      console.log(`Emitted newDialog event for dialog ${newDialog.id} to users ${userId} and ${contact_id}`);
    }

    res.status(201).json({ dialog_id: newDialog.id });
    console.log(`Dialog created successfully between ${userId} and ${contact_id}. ID: ${newDialog.id}`);
  } catch (error: any) {
    console.error(`Error creating dialog between ${userId} and ${contact_id}:`, error);
    if (error.code === '23503') {
      return res.status(404).json({ error: 'Указанный пользователь не найден' });
    } else if (error.code === '23505') {
      return res.status(409).json({ error: 'Диалог уже существует' });
    }
    res.status(500).json({ error: 'Не удалось создать диалог' });
  }
};

export const markDialogReadUnread = async (req: Request, res: Response) => {
  const { dialogId, mark_as_unread } = req.body;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Пользователь не авторизован' });
    return;
  }
  if (!dialogId) {
    res.status(400).json({ error: 'Dialog ID обязателен' });
    return;
  }
  if (typeof mark_as_unread !== 'boolean') {
    res.status(400).json({ error: 'mark_as_unread должен быть boolean' });
    return;
  }

  console.log(`User ${userId} marking dialog ${dialogId} as ${mark_as_unread ? 'unread' : 'read'}`);

  try {
    const isMember = await knex('dialog_participants')
      .where({ dialog_id: dialogId, user_id: userId })
      .first();
    if (!isMember) {
      res.status(403).json({ error: 'Вы не участник этого диалога' });
      return;
    }

    if (!mark_as_unread) {
      const messagesToRead = await knex('messages')
        .select('id')
        .where({ dialog_id: dialogId, sender_id: knex.raw('!= ?', [userId]) });
      const messageIdsToRead = messagesToRead.map((row) => row.id);

      if (messageIdsToRead.length > 0) {
        const values = messageIdsToRead.map((id) => ({
          message_id: id,
          user_id: userId,
          read_at: knex.fn.now(),
        }));
        await knex('message_reads').insert(values).onConflict(['message_id', 'user_id']).ignore();
        await knex('dialog_participants')
          .where({ dialog_id: dialogId, user_id: userId })
          .update({ unread_count: 0 });
        console.log(`Marked ${messageIdsToRead.length} messages as read for user ${userId} in dialog ${dialogId}`);
      }
    } else {
      await knex('message_reads')
        .where({ user_id: userId })
        .whereIn(
          'message_id',
          knex('messages').select('id').where('dialog_id', dialogId)
        )
        .del();
      const unreadCount = await knex('messages')
        .count('id as count')
        .where({ dialog_id: dialogId, sender_id: knex.raw('!= ?', [userId]) })
        .whereNotIn(
          'id',
          knex('message_reads').select('message_id').where('user_id', userId)
        )
        .first();
      await knex('dialog_participants')
        .where({ dialog_id: dialogId, user_id: userId })
        .update({ unread_count: unreadCount?.count || 0 });
      console.log(`Marked dialog ${dialogId} as unread for user ${userId}`);
    }

    const unreadCountResult = await knex('messages as m')
      .leftJoin('message_reads as mr', function () {
        this.on('mr.message_id', '=', 'm.id').andOn('mr.user_id', '=', knex.raw('?', [userId]));
      })
      .where('m.dialog_id', dialogId)
      .where('m.sender_id', '!=', userId)
      .whereNull('mr.message_id')
      .count('m.id as count')
      .first();

    const muteStatusResult = await knex('dialog_participants')
      .select('is_muted')
      .where({ dialog_id: dialogId, user_id: userId })
      .first();

    const eventPayload = {
      dialog_id: dialogId,
      unread_count: Number(unreadCountResult?.count || 0),
      is_muted: muteStatusResult?.is_muted ?? false,
    };
    emitToUser(userId, 'dialogUpdated', eventPayload);

    res.status(200).json({
      message: `Диалог отмечен как ${mark_as_unread ? 'непрочитанный' : 'прочитанный'}`,
      unread_count: Number(unreadCountResult?.count || 0),
    });
  } catch (error: any) {
    console.error(`Error marking dialog ${dialogId} read/unread for user ${userId}:`, error);
    if (error.code === '22P02') {
      res.status(400).json({ error: 'Неверный формат ID диалога' });
    } else {
      res.status(500).json({ error: 'Ошибка при обновлении статуса прочтения диалога' });
    }
  }
};

export const muteDialog = async (req: Request, res: Response) => {
  const { dialogId, is_muted } = req.body;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Пользователь не авторизован' });
    return;
  }
  if (!dialogId) {
    res.status(400).json({ error: 'Dialog ID обязателен' });
    return;
  }
  if (typeof is_muted !== 'boolean') {
    res.status(400).json({ error: 'is_muted должен быть boolean' });
    return;
  }

  try {
    const updateResult = await knex('dialog_participants')
      .where({ dialog_id: dialogId, user_id: userId })
      .update({ is_muted }, ['is_muted']);

    if (updateResult.length === 0) {
      const dialogExists = await knex('dialogs').where('id', dialogId).first();
      if (!dialogExists) {
        res.status(404).json({ error: 'Диалог не найден' });
      } else {
        res.status(403).json({ error: 'Вы не участник этого диалога' });
      }
      return;
    }

    const unreadCountResult = await knex('messages as m')
      .leftJoin('message_reads as mr', function () {
        this.on('mr.message_id', '=', 'm.id').andOn('mr.user_id', '=', knex.raw('?', [userId]));
      })
      .where('m.dialog_id', dialogId)
      .where('m.sender_id', '!=', userId)
      .whereNull('mr.message_id')
      .count('m.id as count')
      .first();

    const eventPayload = {
      dialog_id: dialogId,
      unread_count: Number(unreadCountResult?.count || 0),
      is_muted: is_muted,
    };
    emitToUser(userId, 'dialogUpdated', eventPayload);

    res.status(200).json({
      message: `Диалог ${is_muted ? 'muted' : 'unmuted'}`,
      is_muted,
    });
  } catch (error: any) {
    console.error(`Error muting/unmuting dialog ${dialogId} for user ${userId}:`, error);
    if (error.code === '22P02') {
      res.status(400).json({ error: 'Неверный формат ID диалога' });
    } else {
      res.status(500).json({ error: 'Ошибка при изменении статуса mute диалога' });
    }
  }
};

export const leaveDialog = async (req: Request, res: Response) => {
  const { dialogId } = req.body;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Пользователь не авторизован' });
    return;
  }
  if (!dialogId) {
    res.status(400).json({ error: 'Dialog ID обязателен' });
    return;
  }

  try {
    const dialogInfo = await knex('dialogs as d')
      .select(
        'd.id',
        'd.user1_id',
        'd.user2_id',
        knex.raw(
          'EXISTS (SELECT 1 FROM dialog_participants dp WHERE dp.dialog_id = d.id AND dp.user_id = ?) as is_participant',
          [userId]
        )
      )
      .where('d.id', dialogId)
      .first();

    if (!dialogInfo || !dialogInfo.is_participant) {
      res.status(403).json({ error: 'Вы не участник этого диалога' });
      return;
    }

    const otherUserId = userId === dialogInfo.user1_id ? dialogInfo.user2_id : dialogInfo.user1_id;

    await knex.transaction(async (trx) => {
      await trx('dialogs').where('id', dialogId).del();
      console.log(`User ${userId} deleted dialog ${dialogId}`);
    });

    emitToUser(userId, 'dialogRemoved', { dialogId });
    emitToUser(otherUserId, 'dialogRemoved', { dialogId });

    res.status(200).json({ message: 'Диалог успешно удален' });
  } catch (error: any) {
    console.error(`Error leaving dialog ${dialogId} for user ${userId}:`, error);
    if (error.code === '22P02') {
      res.status(400).json({ error: 'Неверный формат ID диалога' });
    } else {
      res.status(500).json({ error: 'Ошибка при удалении диалога' });
    }
  }
};