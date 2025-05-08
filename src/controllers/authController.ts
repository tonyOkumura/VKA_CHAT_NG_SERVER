import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import knex from '../lib/knex';

const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_TOKEN || 'worisecretkey';

export const register = async (req: Request, res: Response) => {
    const { username, email, password } = req.body;
    console.log('Register request received:', { username, email, password });

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
                password: hashedPassword
            })
            .returning('*');
        
        const user = newUser[0];
        console.log('User inserted into database:', user);

        const { password: _, ...userWithoutPassword } = user;

        res.status(201).json({ message: 'User registered successfully', user: userWithoutPassword });
    } catch (error: any) {
        console.error('Error during registration:', error);
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Username or email already exists.' });
        }
        res.status(500).json({ error: 'Failed to register user' });
    }
};

export const login = async (req: Request, res: Response): Promise<any> => {
    const { email, password } = req.body;
    console.log('Login request received:', { email, password });

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

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '10h' });
        console.log('Token generated:', token);
        
        const { password: _, ...userWithoutPassword } = user;

        res.json({ 
            message: 'User logged in successfully', 
            token: token,
            user: userWithoutPassword
        });
    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};
