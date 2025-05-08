import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import knex from '../lib/knex';

const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET || 'worisecretkey';
const TOKEN_EXPIRY = '10h';
const RESET_TOKEN_EXPIRY = 3600; // 1 час в секундах

// Регистрация пользователя
export const register = async (req: Request, res: Response): Promise<any> => {
  const { username, email, password } = req.body;
  console.log('Register request received:', { username, email });

  try {
    const existingUser = await knex('users').where({ email }).orWhere({ username }).first();
    if (existingUser) {
      if (existingUser.email === email) {
        return res.status(409).json({ error: 'User with this email already exists' });
      }
      if (existingUser.username === username) {
        return res.status(409).json({ error: 'User with this username already exists' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    console.log('Password hashed successfully');

    const newUser = await knex('users')
      .insert({
        username,
        email,
        password: hashedPassword,
        is_online: true // Пользователь сразу "онлайн"
      })
      .returning(['id', 'username', 'email', 'is_online', 'created_at', 'updated_at']);

    const user = newUser[0];
    console.log('User inserted into database:', user);

    res.status(201).json({ message: 'User registered successfully', user });
  } catch (error: any) {
    console.error('Error during registration:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: 'Failed to register user' });
  }
};

// Вход пользователя
export const login = async (req: Request, res: Response): Promise<any> => {
  const { email, password } = req.body;
  console.log('Login request received:', { email });

  try {
    const user = await knex('users').where({ email }).first();
    console.log('User fetched from database:', user);

    if (!user) {
      console.log('User not found');
      return res.status(404).json({ error: 'User not found' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      console.log('Invalid credentials');
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Обновление статуса is_online
    await knex('users').where({ id: user.id }).update({ is_online: true });
    console.log('User is_online updated to TRUE');

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    console.log('Token generated:', token);

    const { password: _, ...userWithoutPassword } = user;

    res.json({
      message: 'User logged in successfully',
      token,
      user: userWithoutPassword
    });
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Выход пользователя
export const logout = async (req: Request, res: Response): Promise<any> => {
  const userId = req.user?.id;
  console.log('Logout request received:', { userId });

  try {
    const updated = await knex('users').where({ id: userId }).update({ is_online: false });
    if (!updated) {
      console.log('User not found');
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('User is_online updated to FALSE');
    res.json({ message: 'User logged out successfully' });
  } catch (error) {
    console.error('Error during logout:', error);
    res.status(500).json({ error: 'Failed to logout' });
  }
};

// Сброс пароля
export const resetPassword = async (req: Request, res: Response): Promise<any> => {
  const { token, newPassword } = req.body;
  console.log('Password reset attempt:', { token });

  try {
    const resetRecord = await knex('password_resets')
      .where({ token })
      .andWhere('expires_at', '>', new Date())
      .first();

    if (!resetRecord) {
      console.log('Invalid or expired reset token');
      return res.status(401).json({ error: 'Invalid or expired reset token' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
    console.log('New password hashed');

    await knex('users').where({ id: resetRecord.user_id }).update({ password: hashedPassword });
    console.log('Password updated for user:', resetRecord.user_id);

    await knex('password_resets').where({ token }).del();
    console.log('Reset token deleted');

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('Error during password reset:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
};

// Проверка авторизации
export const checkAuth = async (req: Request, res: Response): Promise<any> => {
  const userId = req.user?.id;
  console.log('Auth check request received:', { userId });

  try {
    const user = await knex('users')
      .where({ id: userId })
      .select('id', 'username', 'email', 'is_online', 'created_at', 'updated_at')
      .first();

    if (!user) {
      console.log('User not found');
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: 'Authentication successful',
      user
    });
  } catch (error) {
    console.error('Error during auth check:', error);
    res.status(500).json({ error: 'Failed to verify authentication' });
  }
};

// Удаление аккаунта
export const deleteAccount = async (req: Request, res: Response): Promise<any> => {
  const userId = req.user?.id;
  console.log('Delete account request received:', { userId });

  try {
    const deleted = await knex('users').where({ id: userId }).del();
    if (!deleted) {
      console.log('User not found');
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('User deleted:', userId);
    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Error during account deletion:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
};