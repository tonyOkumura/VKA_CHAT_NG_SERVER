import knex from '../lib/knex';
import type { Knex as KnexType } from 'knex';

export const isUserDialogParticipant = async (
  userId: string,
  dialogId: string,
): Promise<boolean> => {
  try {
    const participant = await knex('dialog_participants')
      .where({
        user_id: userId,
        dialog_id: dialogId,
      })
      .select('user_id')
      .first();
    return !!participant;
  } catch (error) {
    console.error(`Error checking dialog participation for user ${userId} in dialog ${dialogId}:`, error);
    return false;
  }
};

export const isUserGroupParticipant = async (
  userId: string,
  groupId: string,
): Promise<boolean> => {
  try {
    const participant = await knex('group_participants')
      .where({
        user_id: userId,
        group_id: groupId,
      })
      .select('user_id')
      .first();
    return !!participant;
  } catch (error) {
    console.error(`Error checking group participation for user ${userId} in group ${groupId}:`, error);
    return false;
  }
};

export const fetchAllDialogParticipants = async (
  dialogId: string,
): Promise<Array<{ id: string; username: string; avatarPath: string | null }>> => {
  try {
    const participants = await knex('dialog_participants as dp')
      .select('u.id', 'u.username', 'u.avatar_path as avatarPath')
      .join('users as u', 'u.id', 'dp.user_id')
      .where('dp.dialog_id', dialogId);
    return participants;
  } catch (error) {
    console.error(`Error fetching participants for dialog ${dialogId}:`, error);
    return [];
  }
};

export const fetchAllGroupParticipants = async (
  groupId: string,
  dbClient?: KnexType | KnexType.Transaction
): Promise<Array<{ id: string; username: string; avatarPath: string | null; role: string }>> => {
  const queryRunner = dbClient || knex;
  try {
    const participants = await queryRunner('group_participants as gp')
      .select(
        'u.id',
        'u.username',
        'u.avatar_path as avatarPath',
        'gr.role'
      )
      .join('users as u', 'u.id', 'gp.user_id')
      .leftJoin('group_roles as gr', function () {
        this.on('gr.group_id', '=', 'gp.group_id').andOn('gr.user_id', '=', 'gp.user_id');
      })
      .where('gp.group_id', groupId);
    return participants.map((p) => ({
      id: p.id,
      username: p.username,
      avatarPath: p.avatarPath,
      role: p.role || 'member',
    }));
  } catch (error) {
    console.error(`Error fetching participants for group ${groupId}:`, error);
    return [];
  }
};

export const getUserDetailsWithAvatar = async (
  userId: string | null | undefined,
  dbClient?: KnexType | KnexType.Transaction
): Promise<{ id: string | null | undefined; username: string | null; avatarPath: string | null }> => {
  if (!userId) return { id: userId, username: null, avatarPath: null };
  const queryRunner = dbClient || knex;
  try {
    const userResult = await queryRunner('users')
      .select('username', 'avatar_path as avatarPath')
      .where('id', userId)
      .first();

    return {
      id: userId,
      username: userResult ? userResult.username : null,
      avatarPath: userResult ? userResult.avatarPath : null,
    };
  } catch (error) {
    console.error(`Error fetching username/avatar for user ${userId}:`, error);
    return { id: userId, username: null, avatarPath: null };
  }
};
export const isUserTaskParticipant = async (
  userId: string,
  taskId: string,
  trx?: KnexType | KnexType.Transaction
): Promise<boolean> => {
  const db = trx || knex;
  const task = await db('tasks')
      .select('creator_id', 'assignee_id')
      .where('id', taskId)
      .first();
  return !!task && (task.creator_id === userId || task.assignee_id === userId);
};