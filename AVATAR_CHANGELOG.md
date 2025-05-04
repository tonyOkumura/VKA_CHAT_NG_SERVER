# Изменения, связанные с аватарами (API и WebSocket)

Этот документ суммирует все изменения, внесенные в бэкенд для поддержки аватаров пользователей и групп.

## База Данных

1.  **Добавлена таблица `user_avatars`:**
    *   Хранит связь `user_id` с файлом аватара.
    *   Содержит поля: `user_id` (PK, FK users), `file_name`, `file_path` (уникальный путь на сервере, например, `/uploads/avatars/avatar-uuid-timestamp.jpg`), `file_type` (MIME-тип), `file_size`, `created_at`, `updated_at`.
    *   Используется триггер для автоматического обновления `updated_at`.
2.  **Добавлено поле `avatar_path` в таблицу `conversations`:**
    *   Хранит путь к аватару *группового* чата (nullable).
    *   Формат пути: `/uploads/group_avatars/group-uuid-timestamp.png`.

## API Эндпоинты

### Новые Эндпоинты

*   **Аватары Пользователей (`/api/avatars`)**
    *   `POST /upload`: (Auth Required) Загрузка/обновление аватара текущего пользователя. Принимает `multipart/form-data` с полем `avatar`. Заменяет старый аватар, если он был. Возвращает `{ message, avatarUrl }`.
    *   `GET /:userId`: Получение URL аватара для конкретного пользователя. Возвращает `{ avatarUrl }` или 404.
    *   `GET /stream/:userId`: Получение файла изображения аватара пользователя (байты). Возвращает файл с правильным `Content-Type` или 404.
    *   `DELETE /delete`: (Auth Required) Удаление аватара текущего пользователя. Возвращает 200 или 404.
*   **Аватары Групп (`/conversations`)**
    *   `POST /:conversationId/avatar`: (Auth Required, Admin Only) Загрузка/обновление аватара для группы. Принимает `multipart/form-data` с полем `avatar`. Возвращает `{ message, groupAvatarUrl }`.
    *   `DELETE /:conversationId/avatar`: (Auth Required, Admin Only) Удаление аватара группы. Возвращает 200 или 404.

### Измененные Эндпоинты (Добавлено `avatarUrl` / `groupAvatarUrl`)

*   `GET /api/users/all`: В каждом объекте пользователя добавлено поле `avatarUrl` (или `null`).
*   `GET /contacts`: В каждом объекте контакта добавлено поле `avatarUrl` (или `null`).
*   `GET /conversations`: В ответе:
    *   Добавлено `groupAvatarUrl` (или `null`) для каждого чата.
    *   Добавлено `adminAvatarUrl` (или `null`) для администратора чата.
    *   В массиве `participants` у каждого участника добавлено `avatarUrl` (или `null`).
    *   В `last_message` добавлено `lastMessageSenderAvatarUrl` (или `null`).
*   `GET /conversations/:conversationId/participants` (или аналогичный): В каждом объекте участника добавлено `avatarUrl` (или `null`). (Примечание: Проверьте фактический роут, если он отличается).
*   `GET /conversations/{id}/messages` (или аналогичный): В каждом объекте сообщения:
    *   Добавлено `senderAvatarUrl` (или `null`).
    *   В массиве `read_by_users` у каждого прочитавшего добавлено `avatarUrl` (или `null`).
*   `GET /tasks`: В каждом объекте задачи добавлены `creatorAvatarUrl` и `assigneeAvatarUrl` (или `null`).
*   `GET /tasks/{id}` (или аналогичный): В объекте задачи добавлены `creatorAvatarUrl` и `assigneeAvatarUrl` (или `null`).
*   `GET /tasks/{id}/comments`: В каждом объекте комментария добавлено `commenterAvatarUrl` (или `null`).

## События WebSocket

### Измененные События (Добавлены `avatarUrl`)

*   `newMessage` (комната чата):
    *   В объекте сообщения добавлено `senderAvatarUrl` (или `null`).
    *   В массиве `read_by_users` у каждого прочитавшего добавлено `avatarUrl` (или `null`).
*   `messagesRead` (комната чата):
    *   В объекте события добавлено `avatarUrl` пользователя, прочитавшего сообщения (или `null`).
*   `messageReadUpdate` (комната чата):
    *   В объекте события добавлено `avatarUrl` пользователя, прочитавшего сообщение (или `null`).
*   `newTaskCreated` (комната `general_tasks`):
    *   В объекте задачи добавлены `creatorAvatarUrl` и `assigneeAvatarUrl` (или `null`).
*   `taskUpdated` (комната `general_tasks` и комната задачи `task_{id}`):
    *   В объекте задачи добавлены `creatorAvatarUrl` и `assigneeAvatarUrl` (или `null`).
    *   В объекте `changed_by` добавлено `avatarUrl` пользователя, внесшего изменения.
*   `newTaskComment` (комната задачи `task_{id}`):
    *   В объекте комментария добавлено `commenterAvatarUrl` (или `null`).
*   `conversationUpdated` (комната чата):
    *   Это событие теперь отправляется при добавлении/удалении участника, переименовании группы, изменении/удалении аватара группы, выходе пользователя из группы.
    *   Полный объект чата включает `groupAvatarUrl` и массив `participants` с `avatarUrl` у каждого.

### Новые События

*   `userRemovedFromGroup` (личная комната пользователя): Отправляется пользователю, которого удалили из группы. Содержит `{ conversation_id, user_id }`.
*   `conversationLeft` (личная комната пользователя): Отправляется пользователю, который вышел из группы. Содержит `{ id: conversationId }`.
*   `conversationDeleted` (личная комната пользователя): Отправляется пользователю, который удалил диалог. Содержит `{ id: conversationId }`.

## Бэкенд Структура

*   Созданы `src/controllers/avatarController.ts` и `src/routes/avatarRoutes.ts` для управления аватарами пользователей.
*   Логика управления аватарами групп добавлена в `conversationController.ts` и `conversationsRoutes.ts`.
*   Добавлена конфигурация `multer` для загрузки файлов аватаров пользователей и групп.
*   Настроен `express.static` для статического обслуживания папок `uploads/avatars` и `uploads/group_avatars`.
*   Добавлено глобальное расширение типа (`src/types/express/index.d.ts`) для `Express.Request`, чтобы включить `req.user` из middleware `verifyToken`.
*   Множество контроллеров (`userController`, `contactsController`, `conversationController`, `messagesController`, `taskController`) и обработчиков WebSocket (`index.ts`) были обновлены для включения информации об аватарах. 