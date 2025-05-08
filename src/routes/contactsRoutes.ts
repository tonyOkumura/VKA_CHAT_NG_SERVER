import { Router } from "express";
import { addContact, fetchContacts, deleteContact, searchUsers } from "../controllers/contactsController";
import { authMiddleware } from "../middlewares/authMiddleware";

const router = Router();


router.get('/', authMiddleware, fetchContacts);

router.post('/', authMiddleware, addContact);

router.delete('/:contactId', authMiddleware, deleteContact);

router.get('/search', authMiddleware, searchUsers);

export default router;