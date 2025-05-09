import { Router } from 'express';
import {
    createEvent,
    getEvents,
    getEventById,
    updateEvent,
    deleteEvent,
    addEventParticipant,
    getEventParticipants,
    updateEventParticipantStatus,
    removeEventParticipant,
    // TODO: Import task linking functions if implemented
} from '../controllers/eventsController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

// Apply auth middleware to all event routes
router.use(authMiddleware);

// Event CRUD
router.post('/', createEvent);
router.get('/', getEvents);
router.get('/:eventId', getEventById);
router.put('/:eventId', updateEvent);
router.delete('/:eventId', deleteEvent);

// Event Participants Management
router.post('/:eventId/participants', addEventParticipant);
router.get('/:eventId/participants', getEventParticipants);
router.put('/:eventId/participants/:participantUserId', updateEventParticipantStatus);
router.delete('/:eventId/participants/:participantUserId', removeEventParticipant);

// TODO: Add routes for event tasks if implemented
// router.post('/:eventId/tasks/:taskId', linkTaskToEvent);
// router.delete('/:eventId/tasks/:taskId', unlinkTaskFromEvent);
// router.get('/:eventId/tasks', getEventTasks);

export default router; 