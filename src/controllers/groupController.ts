import { Request, Response } from 'express';
import knex from '../lib/knex';
import { emitToUser, emitToRoom } from '../services/socket/socketService';

const fetchFullGroupDetails = async (groupId: string, ): Promise<any | null> => {
  console.log(`Fetching full details for group: ${groupId}`);

  try {
    const group = await knex('groups as g')
      .select(
        'g.id as group_id',
        'g.name as group_name',
        'g.admin_id',
        'g.avatar_path as groupAvatarPath',
        'g.created_at',
        'u.username as admin_username',
        'u.avatar_path as adminAvatarPath'
      )
      .join('users as u', 'u.id', 'g.admin_id')
      .where('g.id', groupId)
      .first();

    if (!group) {
      console.warn(`Group ${groupId} not found`);
      return null;
    }

    const participants = await knex('group_participants as gp')
      .select(
        'u.id as user_id',
        'u.username',
        'u.email',
        'u.is_online',
        'u.avatar_path as avatarPath'
      )
      .join('users as u', 'u.id', 'gp.user_id')
      .where('gp.group_id', groupId)
      .orderBy('u.username');

    const roles = await knex('group_roles')
      .select('user_id', 'role')
      .where('group_id', groupId);

    const participantsWithRoles = participants.map((p) => ({
      ...p,
      role: roles.find((r) => r.user_id === p.user_id)?.role || 'member',
    }));

    return {
      group_id: group.group_id,
      conversation_name: group.group_name,
      is_group: true,
      groupAvatarPath: group.groupAvatarPath,
      admin_id: group.admin_id,
      admin_username: group.admin_username,
      adminAvatarPath: group.adminAvatarPath,
      participants: participantsWithRoles,
      created_at: group.created_at,
    };
  } catch (error) {
    console.error(`Error fetching group details for ${groupId}:`, error);
    return null;
  }
};

export const fetchAllGroupsByUserId = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    console.warn('Attempt to fetch groups without authentication');
    res.status(401).json({ error: 'Пользователь не авторизован' });
    return;
  }

  console.log(`Fetching groups for user: ${userId}`);

  try {
    const lastMessagesCte = knex('messages as m')
      .distinctOn('m.group_id')
      .select(
        'm.group_id',
        'm.content',
        'm.created_at',
        'm.sender_id',
        'm.sender_username',
        'm.is_forwarded',
        'm.forwarded_from_username'
      )
      .whereNotNull('m.group_id')
      .orderBy('m.group_id')
      .orderBy('m.created_at', 'desc');

    const unreadCountsCte = knex('messages as m')
      .select('m.group_id', knex.raw('COUNT(m.id)::int as unread_count'))
      .join('group_participants as gp', 'gp.group_id', 'm.group_id')
      .leftJoin('message_reads as mr', function () {
        this.on('mr.message_id', '=', 'm.id').andOn('mr.user_id', '=', knex.raw('?', [userId]));
      })
      .where('gp.user_id', userId)
      .where('m.sender_id', '!=', userId)
      .whereNull('mr.message_id')
      .groupBy('m.group_id');

    const groups = await knex('groups as g')
      .with('last_messages_cte', lastMessagesCte)
      .with('unread_counts_cte', unreadCountsCte)
      .select(
        'g.id as group_id',
        'g.name as conversation_name',
        'g.avatar_path as groupAvatarPath',
        'g.admin_id',
        'u.username as admin_username',
        'u.avatar_path as adminAvatarPath',
        'lmc.content as last_message',
        'lmc.created_at as last_message_time',
        'lmc.sender_id as last_message_sender_id',
        'lmc.sender_username as last_message_sender_username',
        'lmc.is_forwarded as last_message_is_forwarded',
        'lmc.forwarded_from_username as last_message_forwarded_from',
        'gp.is_muted',
        'gp.last_read_timestamp',
        'gp.notification_settings',
        'g.created_at as conversation_created_at',
        knex.raw('COALESCE(ucc.unread_count, 0) as unread_count')
      )
      .join('group_participants as gp', 'gp.group_id', 'g.id')
      .join('users as u', 'u.id', 'g.admin_id')
      .leftJoin('last_messages_cte as lmc', 'lmc.group_id', 'g.id')
      .leftJoin('unread_counts_cte as ucc', 'ucc.group_id', 'g.id')
      .where('gp.user_id', userId)
      .orderByRaw('lmc.created_at DESC NULLS LAST');

    const formattedResults = groups.map((row) => ({
      group_id: row.group_id,
      conversation_name: row.conversation_name,
      is_group: true,
      groupAvatarPath: row.groupAvatarPath,
      admin_id: row.admin_id,
      admin_username: row.admin_username,
      adminAvatarPath: row.adminAvatarPath,
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
    console.error('Ошибка при получении списка групп:', error);
    res.status(500).json({ error: 'Не удалось получить список групп' });
  }
};

export const createGroup = async (req: Request, res: Response): Promise<any> => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Пользователь не авторизован' });
  }
  const { name, participant_ids = [] } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Название группы обязательно' });
  }
  if (!Array.isArray(participant_ids)) {
    return res.status(400).json({ error: 'participant_ids должен быть массивом' });
  }

  const uniqueParticipants = Array.from(new Set([userId, ...participant_ids.filter((id) => typeof id === 'string')]));
  console.log(`User ${userId} creating group "${name}" with participants: ${uniqueParticipants.join(', ')}`);

  try {
    const existingUsers = await knex('users').select('id').whereIn('id', uniqueParticipants);
    if (existingUsers.length !== uniqueParticipants.length) {
      const foundIds = new Set(existingUsers.map((u) => u.id));
      const missingIds = uniqueParticipants.filter((id) => !foundIds.has(id));
      return res.status(404).json({ error: `Пользователи не найдены: ${missingIds.join(', ')}` });
    }

    const newGroup = await knex.transaction(async (trx) => {
      const [insertedGroup] = await trx('groups')
        .insert({ name: name.trim(), admin_id: userId })
        .returning(['id']);

      const participantObjects = uniqueParticipants.map((pId) => ({
        group_id: insertedGroup.id,
        user_id: pId,
      }));
      await trx('group_participants').insert(participantObjects);

      await trx('group_roles').insert({
        group_id: insertedGroup.id,
        user_id: userId,
        role: 'admin',
      });

      return insertedGroup;
    });

    const fullGroupDetails = await fetchFullGroupDetails(newGroup.id,);
    if (fullGroupDetails) {
      uniqueParticipants.forEach((pId) => {
        emitToUser(pId, 'newGroup', fullGroupDetails);
      });
      console.log(`Emitted newGroup event for group ${newGroup.id} to ${uniqueParticipants.length} users`);
    }

    res.status(201).json({ group_id: newGroup.id });
    console.log(`Group "${name}" (ID: ${newGroup.id}) created successfully by user ${userId}`);
  } catch (error: any) {
    console.error(`Error creating group "${name}" by user ${userId}:`, error);
    if (error.code === '23503') {
      return res.status(404).json({ error: 'Пользователь не найден' });
    } else if (error.code === '23505') {
      return res.status(409).json({ error: 'Конфликт данных при создании группы' });
    }
    res.status(500).json({ error: 'Не удалось создать группу' });
  }
};

export const addParticipantToGroup = async (req: Request, res: Response): Promise<any> => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Пользователь не авторизован' });
  }
  const { group_id, participant_id } = req.body;
  if (!group_id || !participant_id) {
    return res.status(400).json({ error: 'group_id и participant_id обязательны' });
  }

  console.log(`User ${userId} attempting to add participant ${participant_id} to group ${group_id}`);

  try {
    const group = await knex('groups').select('admin_id').where('id', group_id).first();
    if (!group) {
      return res.status(404).json({ error: 'Группа не найдена' });
    }
    if (group.admin_id !== userId) {
      return res.status(403).json({ error: 'Только администратор может добавлять участников' });
    }

    const userExists = await knex('users').where('id', participant_id).first();
    if (!userExists) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const participantExists = await knex('group_participants')
      .where({ group_id, user_id: participant_id })
      .first();
    if (participantExists) {
      return res.status(409).json({ error: 'Пользователь уже является участником группы' });
    }

    await knex('group_participants').insert({ group_id, user_id: participant_id });

    const updatedDetails = await fetchFullGroupDetails(group_id);
    if (updatedDetails) {
      updatedDetails.participants.forEach((p: any) => {
        emitToUser(p.user_id, 'groupUpdated', updatedDetails);
      });
      console.log(`Emitted groupUpdated after adding participant ${participant_id} to ${group_id}`);
    }

    res.status(200).json({ message: 'Участник успешно добавлен' });
  } catch (error: any) {
    console.error(`Error adding participant ${participant_id} to group ${group_id}:`, error);
    if (error.code === '23503') {
      return res.status(404).json({ error: 'Группа или пользователь не найдены' });
    } else if (error.code === '23505') {
      return res.status(409).json({ error: 'Пользователь уже участник группы' });
    }
    res.status(500).json({ error: 'Не удалось добавить участника' });
  }
};

export const removeParticipantFromGroup = async (req: Request, res: Response): Promise<any> => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Пользователь не авторизован' });
  }
  const { group_id, participant_id } = req.body;
  if (!group_id || !participant_id) {
    return res.status(400).json({ error: 'group_id и participant_id обязательны' });
  }
  if (userId === participant_id) {
    return res.status(400).json({ error: 'Нельзя удалить себя через этот метод, используйте leaveGroup' });
  }

  console.log(`User ${userId} attempting to remove participant ${participant_id} from group ${group_id}`);

  try {
    const group = await knex('groups').select('admin_id').where('id', group_id).first();
    if (!group) {
      return res.status(404).json({ error: 'Группа не найдена' });
    }
    if (group.admin_id !== userId) {
      return res.status(403).json({ error: 'Только администратор может удалять участников' });
    }

    const deleteResult = await knex('group_participants')
      .where({ group_id, user_id: participant_id })
      .del();

    if (deleteResult === 0) {
      return res.status(404).json({ error: 'Участник не найден в группе' });
    }

    const updatedDetails = await fetchFullGroupDetails(group_id);
    if (updatedDetails) {
      updatedDetails.participants.forEach((p: any) => {
        emitToUser(p.user_id, 'groupUpdated', updatedDetails);
      });
      emitToUser(participant_id, 'groupRemoved', { groupId: group_id });
      console.log(`Emitted group events after removing participant ${participant_id} from ${group_id}`);
    }

    res.status(200).json({ message: 'Участник успешно удален' });
  } catch (error: any) {
    console.error(`Error removing participant ${participant_id} from group ${group_id}:`, error);
    if (error.code === '22P02') {
      return res.status(400).json({ error: 'Неверный формат ID группы или участника' });
    }
    res.status(500).json({ error: 'Не удалось удалить участника' });
  }
};

export const updateGroupName = async (req: Request, res: Response): Promise<any> => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Пользователь не авторизован' });
  }
  const { group_id, group_name } = req.body;
  if (!group_id || !group_name || typeof group_name !== 'string' || group_name.trim().length === 0) {
    return res.status(400).json({ error: 'group_id и непустое group_name обязательны' });
  }

  console.log(`User ${userId} attempting to rename group ${group_id} to "${group_name.trim()}"`);

  try {
    const group = await knex('groups').select('admin_id').where('id', group_id).first();
    if (!group) {
      return res.status(404).json({ error: 'Группа не найдена' });
    }
    if (group.admin_id !== userId) {
      return res.status(403).json({ error: 'Только администратор может переименовать группу' });
    }

    const [updatedGroup] = await knex('groups')
      .where('id', group_id)
      .update({ name: group_name.trim() }, ['name']);

    const updatedDetails = await fetchFullGroupDetails(group_id);
    if (updatedDetails) {
      emitToRoom(group_id, 'groupUpdated', updatedDetails);
      console.log(`Emitted groupUpdated after rename to room ${group_id}`);
    }

    res.status(200).json({ group_name: updatedGroup.name });
  } catch (error: any) {
    console.error(`Error updating group name for ${group_id}:`, error);
    if (error.code === '22P02') {
      return res.status(400).json({ error: 'Неверный формат ID группы' });
    }
    res.status(500).json({ error: 'Не удалось обновить название группы' });
  }
};

export const fetchAllParticipantsByGroupId = async (req: Request, res: Response): Promise<any> => {
  const { groupId } = req.query;
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ error: 'Пользователь не авторизован' });
  }
  if (!groupId || typeof groupId !== 'string') {
    return res.status(400).json({ error: 'groupId обязателен и должен быть строкой' });
  }

  try {
    const isMember = await knex('group_participants')
      .where({ group_id: groupId, user_id: userId })
      .first();
    if (!isMember) {
      return res.status(403).json({ error: 'Вы не участник этой группы' });
    }

    const participants = await knex('group_participants as gp')
      .select(
        'u.id as user_id',
        'u.username',
        'u.email',
        'u.is_online',
        'u.avatar_path as avatarPath',
        'gr.role'
      )
      .join('users as u', 'u.id', 'gp.user_id')
      .leftJoin('group_roles as gr', function () {
        this.on('gr.group_id', '=', 'gp.group_id').andOn('gr.user_id', '=', 'gp.user_id');
      })
      .where('gp.group_id', groupId)
      .orderBy('u.username');

    const formattedParticipants = participants.map((p) => ({
      user_id: p.user_id,
      username: p.username,
      email: p.email,
      is_online: p.is_online,
      avatarPath: p.avatarPath,
      role: p.role || 'member',
    }));

    res.json(formattedParticipants);
  } catch (error: any) {
    console.error(`Error fetching participants for group ${groupId}:`, error);
    if (error.code === '22P02') {
      return res.status(400).json({ error: 'Неверный формат ID группы' });
    }
    res.status(500).json({ error: 'Не удалось получить участников группы' });
  }
};

export const markGroupReadUnread = async (req: Request, res: Response) => {
  const { groupId, mark_as_unread } = req.body;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Пользователь не авторизован' });
    return;
  }
  if (!groupId) {
    res.status(400).json({ error: 'groupId обязателен' });
    return;
  }
  if (typeof mark_as_unread !== 'boolean') {
    res.status(400).json({ error: 'mark_as_unread должен быть boolean' });
    return;
  }

  console.log(`User ${userId} marking group ${groupId} as ${mark_as_unread ? 'unread' : 'read'}`);

  try {
    const isMember = await knex('group_participants')
      .where({ group_id: groupId, user_id: userId })
      .first();
    if (!isMember) {
      res.status(403).json({ error: 'Вы не участник этой группы' });
      return;
    }

    if (!mark_as_unread) {
      const messagesToRead = await knex('messages')
        .select('id')
        .where({ group_id: groupId, sender_id: knex.raw('!= ?', [userId]) });
      const messageIdsToRead = messagesToRead.map((row) => row.id);

      if (messageIdsToRead.length > 0) {
        const values = messageIdsToRead.map((id) => ({
          message_id: id,
          user_id: userId,
          read_at: knex.fn.now(),
        }));
        await knex('message_reads').insert(values).onConflict(['message_id', 'user_id']).ignore();
        await knex('group_participants')
          .where({ group_id: groupId, user_id: userId })
          .update({ unread_count: 0 });
        console.log(`Marked ${messageIdsToRead.length} messages as read for user ${userId} in group ${groupId}`);
      }
    } else {
      await knex('message_reads')
        .where({ user_id: userId })
        .whereIn(
          'message_id',
          knex('messages').select('id').where('group_id', groupId)
        )
        .del();
      const unreadCount = await knex('messages')
        .count('id as count')
        .where({ group_id: groupId, sender_id: knex.raw('!= ?', [userId]) })
        .whereNotIn(
          'id',
          knex('message_reads').select('message_id').where('user_id', userId)
        )
        .first();
      await knex('group_participants')
        .where({ group_id: groupId, user_id: userId })
        .update({ unread_count: unreadCount?.count || 0 });
      console.log(`Marked group ${groupId} as unread for user ${userId}`);
    }

    const unreadCountResult = await knex('messages as m')
      .leftJoin('message_reads as mr', function () {
        this.on('mr.message_id', '=', 'm.id').andOn('mr.user_id', '=', knex.raw('?', [userId]));
      })
      .where('m.group_id', groupId)
      .where('m.sender_id', '!=', userId)
      .whereNull('mr.message_id')
      .count('m.id as count')
      .first();

    const muteStatusResult = await knex('group_participants')
      .select('is_muted')
      .where({ group_id: groupId, user_id: userId })
      .first();

    const eventPayload = {
      group_id: groupId,
      unread_count: Number(unreadCountResult?.count || 0),
      is_muted: muteStatusResult?.is_muted ?? false,
    };
    emitToUser(userId, 'groupUpdated', eventPayload);

    res.status(200).json({
      message: `Группа отмечена как ${mark_as_unread ? 'непрочитанная' : 'прочитанная'}`,
      unread_count: Number(unreadCountResult?.count || 0),
    });
  } catch (error: any) {
    console.error(`Error marking group ${groupId} read/unread for user ${userId}:`, error);
    if (error.code === '22P02') {
      res.status(400).json({ error: 'Неверный формат ID группы' });
    } else {
      res.status(500).json({ error: 'Ошибка при обновлении статуса прочтения группы' });
    }
  }
};

export const muteGroup = async (req: Request, res: Response) => {
  const { groupId, is_muted } = req.body;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Пользователь не авторизован' });
    return;
  }
  if (!groupId) {
    res.status(400).json({ error: 'groupId обязателен' });
    return;
  }
  if (typeof is_muted !== 'boolean') {
    res.status(400).json({ error: 'is_muted должен быть boolean' });
    return;
  }

  try {
    const updateResult = await knex('group_participants')
      .where({ group_id: groupId, user_id: userId })
      .update({ is_muted }, ['is_muted']);

    if (updateResult.length === 0) {
      const groupExists = await knex('groups').where('id', groupId).first();
      if (!groupExists) {
        res.status(404).json({ error: 'Группа не найдена' });
      } else {
        res.status(403).json({ error: 'Вы не участник этой группы' });
      }
      return;
    }

    const unreadCountResult = await knex('messages as m')
      .leftJoin('message_reads as mr', function () {
        this.on('mr.message_id', '=', 'm.id').andOn('mr.user_id', '=', knex.raw('?', [userId]));
      })
      .where('m.group_id', groupId)
      .where('m.sender_id', '!=', userId)
      .whereNull('mr.message_id')
      .count('m.id as count')
      .first();

    const eventPayload = {
      group_id: groupId,
      unread_count: Number(unreadCountResult?.count || 0),
      is_muted: is_muted,
    };
    emitToUser(userId, 'groupUpdated', eventPayload);

    res.status(200).json({
      message: `Группа ${is_muted ? 'muted' : 'unmuted'}`,
      is_muted,
    });
  } catch (error: any) {
    console.error(`Error muting/unmuting group ${groupId} for user ${userId}:`, error);
    if (error.code === '22P02') {
      res.status(400).json({ error: 'Неверный формат ID группы' });
    } else {
      res.status(500).json({ error: 'Ошибка при изменении статуса mute группы' });
    }
  }
};

export const leaveGroup = async (req: Request, res: Response) => {
  const { groupId } = req.body;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Пользователь не авторизован' });
    return;
  }
  if (!groupId) {
    res.status(400).json({ error: 'groupId обязателен' });
    return;
  }

  try {
    const groupInfo = await knex('groups as g')
      .select(
        'g.id',
        'g.admin_id',
        knex.raw(
          '(SELECT COUNT(*) FROM group_participants gp WHERE gp.group_id = g.id)::int as participant_count'
        ),
        knex.raw(
          'EXISTS (SELECT 1 FROM group_participants gp WHERE gp.group_id = g.id AND gp.user_id = ?) as is_participant',
          [userId]
        )
      )
      .where('g.id', groupId)
      .first();

    if (!groupInfo || !groupInfo.is_participant) {
      res.status(403).json({ error: 'Вы не участник этой группы' });
      return;
    }

    await knex.transaction(async (trx) => {
      await trx('group_participants').where({ group_id: groupId, user_id: userId }).del();

      const remainingParticipants = groupInfo.participant_count - 1;

      if (remainingParticipants === 0) {
        await trx('groups').where('id', groupId).del();
        console.log(`Group ${groupId} deleted as last participant left`);
      } else if (userId === groupInfo.admin_id) {
        const newAdmin = await trx('group_participants')
          .select('user_id')
          .where('group_id', groupId)
          .orderBy('joined_at', 'asc')
          .first();
        if (newAdmin) {
          await trx('groups').where('id', groupId).update({ admin_id: newAdmin.user_id });
          await trx('group_roles')
            .where({ group_id: groupId, user_id: userId })
            .del();
          await trx('group_roles').insert({
            group_id: groupId,
            user_id: newAdmin.user_id,
            role: 'admin',
          });
          console.log(`Admin ${userId} left group ${groupId}, new admin assigned: ${newAdmin.user_id}`);
        } else {
          await trx('groups').where('id', groupId).del();
          console.log(`Group ${groupId} deleted as no new admin could be assigned`);
        }
      }
    });

    const updatedDetails = await fetchFullGroupDetails(groupId);
    if (updatedDetails) {
      updatedDetails.participants.forEach((p: any) => {
        emitToUser(p.user_id, 'groupUpdated', updatedDetails);
      });
    }
    emitToUser(userId, 'groupRemoved', { groupId });

    res.status(200).json({ message: 'Вы успешно покинули группу' });
  } catch (error: any) {
    console.error(`Error leaving group ${groupId} for user ${userId}:`, error);
    if (error.code === '22P02') {
      res.status(400).json({ error: 'Неверный формат ID группы' });
    } else {
      res.status(500).json({ error: 'Ошибка при выходе из группы' });
    }
  }
};