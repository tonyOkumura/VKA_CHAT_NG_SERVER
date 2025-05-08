import { Request, Response } from 'express';
import knex from '../lib/knex';
import { emitToUser } from '../services/socket/socketService';
import { v4 as uuidv4 } from 'uuid';

export const fetchContacts = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  console.log(`Fetch contacts request for user: ${userId}`);

  try {
    const contacts = await knex('contacts as c')
      .select(
        'c.contact_id as id',
        'u.username',
        'u.avatar_path as avatarUrl',
        'u.is_online as isOnline',
        'c.created_at',
        'c.updated_at'
      )
      .join('users as u', 'c.contact_id', 'u.id')
      .where('c.user_id', userId);

    res.json({ message: 'Contacts fetched successfully', contacts });
  } catch (error: any) {
    console.error(`Error fetching contacts for user ${userId}:`, error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};

export const addContact = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  const { contact_id } = req.body;
  console.log(`Add contact request: user ${userId}, contact ${contact_id}`);

  if (!contact_id) {
    res.status(400).json({ error: 'Contact ID is required' });
    return;
  }

  if (userId === contact_id) {
    res.status(400).json({ error: 'Cannot add yourself as a contact' });
    return;
  }

  try {
    // Проверка существования пользователя
    const contactUser = await knex('users')
      .select('id', 'username', 'avatar_path as avatarUrl', 'is_online as isOnline')
      .where('id', contact_id)
      .first();

    if (!contactUser) {
      res.status(404).json({ error: 'Contact user not found' });
      return;
    }

    // Проверка, не является ли пользователь уже контактом
    const existingContact = await knex('contacts')
      .where({ user_id: userId, contact_id })
      .first();

    if (existingContact) {
      res.status(409).json({ error: 'Contact already exists' });
      return;
    }

    // Добавление контакта
    const [newContact] = await knex('contacts')
      .insert({
        id: uuidv4(),
        user_id: userId,
        contact_id,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning(['id', 'user_id', 'contact_id', 'created_at', 'updated_at']);

    // Создание уведомления для contact_id
    const [notification] = await knex('notifications')
      .insert({
        id: uuidv4(),
        user_id: contact_id,
        type: 'contact_added',
        content: `User ${req.user?.username} added you as a contact`,
        related_id: userId,
        created_at: new Date()
      })
      .returning(['id', 'user_id', 'type', 'content', 'related_id', 'created_at']);

    // Эмиссия события contactAdded
    const currentUser = await knex('users')
      .select('username', 'avatar_path as avatarUrl', 'is_online as isOnline')
      .where('id', userId)
      .first();

    emitToUser(contact_id, 'contactAdded', {
      contact: {
        id: userId,
        username: currentUser?.username,
        avatarUrl: currentUser?.avatarUrl,
        isOnline: currentUser?.isOnline
      },
      notification
    });

    res.status(201).json({
      message: 'Contact added successfully',
      contact: {
        id: contactUser.id,
        username: contactUser.username,
        avatarUrl: contactUser.avatarUrl,
        isOnline: contactUser.isOnline,
        created_at: newContact.created_at,
        updated_at: newContact.updated_at
      }
    });
  } catch (error: any) {
    console.error(`Error adding contact for user ${userId}:`, error);
    if (error.code === '23503') {
      res.status(404).json({ error: 'Contact user not found' });
    } else if (error.code === '23505') {
      res.status(409).json({ error: 'Contact already exists' });
    } else {
      res.status(500).json({ error: 'Failed to add contact' });
    }
  }
};

export const deleteContact = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  const { contactId } = req.params;
  console.log(`Delete contact request: user ${userId}, contact ${contactId}`);

  try {
    const deleted = await knex('contacts')
      .where({ user_id: userId, contact_id: contactId })
      .del();

    if (!deleted) {
      res.status(404).json({ error: 'Contact not found' });
      return;
    }

    // Эмиссия события contactRemoved
    emitToUser(contactId, 'contactRemoved', {
      userId,
      username: req.user?.username
    });

    res.json({ message: 'Contact deleted successfully' });
  } catch (error: any) {
    console.error(`Error deleting contact for user ${userId}:`, error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
};

export const searchUsers = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  const query = req.query.q as string;
  console.log(`Search users request: user ${userId}, query ${query}`);

  if (!query || query.length < 2) {
    res.status(400).json({ error: 'Search query must be at least 2 characters long' });
    return;
  }

  try {
    const users = await knex('users')
      .select('id', 'username', 'avatar_path as avatarUrl', 'is_online as isOnline')
      .whereNot('id', userId)
      .andWhere(function () {
        this.where('username', 'ILIKE', `%${query}%`).orWhere('email', 'ILIKE', `%${query}%`);
      })
      .whereNotExists(function () {
        this.select('*')
          .from('contacts')
          .where('contacts.user_id', userId)
          .andWhereRaw('contacts.contact_id = users.id');
      })
      .limit(20);

    res.json({ message: 'Users found successfully', users });
  } catch (error: any) {
    console.error(`Error searching users for user ${userId}:`, error);
    res.status(500).json({ error: 'Failed to search users' });
  }
};