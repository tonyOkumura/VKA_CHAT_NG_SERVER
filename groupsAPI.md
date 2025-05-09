# Groups API

This document outlines the API endpoints for managing user groups (group conversations).
All endpoints require authentication and the `Authorization: Bearer <token>` header.
The base path for these routes is `/api/groups`.

## Fetch All Groups for User

-   **URL:** `/`
-   **Method:** `GET`
-   **Description:** Retrieves a list of all groups the authenticated user is a member of, along with last message, unread counts, and other metadata.
-   **Success Response (200):**
    ```json
    [
        {
            "group_id": "uuid",
            "conversation_name": "string", // Group name
            "is_group": true,
            "groupAvatarPath": "string | null", // Group avatar URL
            "admin_id": "uuid",
            "admin_username": "string",
            "adminAvatarPath": "string | null",
            "last_message": "string | null",
            "last_message_time": "timestamp | null",
            "last_message_sender_id": "uuid | null",
            "last_message_sender_username": "string | null",
            "last_message_is_forwarded": "boolean | null",
            "last_message_forwarded_from": "string | null",
            "last_message_content_preview": "string | null",
            "unread_count": "integer",
            "is_muted": "boolean",
            "last_read_timestamp": "timestamp | null",
            "notification_settings": {"sound": true, "vibration": true}, // Example
            "conversation_created_at": "timestamp"
        }
    ]
    ```
-   **Error Responses:**
    -   `401 Unauthorized`: "Пользователь не авторизован"
    -   `500 Internal Server Error`: "Не удалось получить список групп"

## Create Group

-   **URL:** `/`
-   **Method:** `POST`
-   **Description:** Creates a new group. The creator becomes the admin.
-   **Request Body:**
    ```json
    {
        "name": "string", // Group name
        "participant_ids": ["uuid", "uuid"] // Optional array of user IDs to add to the group
    }
    ```
-   **Success Response (201):**
    ```json
    {
        "group_id": "uuid"
    }
    ```
    *Socket Event Emitted:* `newGroup` to all initial participants with full group details:
    ```json
    {
        "group_id": "uuid",
        "conversation_name": "string",
        "is_group": true,
        "groupAvatarPath": "string | null",
        "admin_id": "uuid",
        "admin_username": "string",
        "adminAvatarPath": "string | null",
        "participants": [
            { "user_id": "uuid", "username": "string", "email": "string", "is_online": "boolean", "avatarPath": "string | null", "role": "admin" | "member" }
        ],
        "created_at": "timestamp"
    }
    ```
-   **Error Responses:**
    -   `400 Bad Request`: "Название группы обязательно", "participant_ids должен быть массивом"
    -   `401 Unauthorized`: "Пользователь не авторизован"
    -   `404 Not Found`: "Пользователи не найдены: {missing_ids}"
    -   `409 Conflict`: "Конфликт данных при создании группы"
    -   `500 Internal Server Error`: "Не удалось создать группу"

## Add Participant to Group

-   **URL:** `/participants/add`
-   **Method:** `POST`
-   **Description:** Adds a participant to a group. Only the group admin can perform this action.
-   **Request Body:**
    ```json
    {
        "group_id": "uuid",
        "participant_id": "uuid"
    }
    ```
-   **Success Response (200):**
    ```json
    {
        "message": "Участник успешно добавлен"
    }
    ```
    *Socket Event Emitted:* `groupUpdated` to all current participants of the group with full updated group details (same structure as `newGroup` event).
-   **Error Responses:**
    -   `400 Bad Request`: "group_id и participant_id обязательны"
    -   `401 Unauthorized`: "Пользователь не авторизован"
    -   `403 Forbidden`: "Только администратор может добавлять участников"
    -   `404 Not Found`: "Группа не найдена", "Пользователь не найден"
    -   `409 Conflict`: "Пользователь уже является участником группы" or "Пользователь уже участник группы"
    -   `500 Internal Server Error`: "Не удалось добавить участника"

## Remove Participant from Group

-   **URL:** `/participants/remove`
-   **Method:** `DELETE`
-   **Description:** Removes a participant from a group. Only the group admin can perform this action. Admins cannot remove themselves with this endpoint; they must use `/leave`.
-   **Request Body:**
    ```json
    {
        "group_id": "uuid",
        "participant_id": "uuid"
    }
    ```
-   **Success Response (200):**
    ```json
    {
        "message": "Участник успешно удален"
    }
    ```
    *Socket Events Emitted:*
    -   `groupUpdated` to remaining participants with full updated group details.
    -   `groupRemoved` to the removed participant: `{"groupId": "uuid"}`.
-   **Error Responses:**
    -   `400 Bad Request`: "group_id и participant_id обязательны", "Нельзя удалить себя через этот метод, используйте leaveGroup", "Неверный формат ID группы или участника"
    -   `401 Unauthorized`: "Пользователь не авторизован"
    -   `403 Forbidden`: "Только администратор может удалять участников"
    -   `404 Not Found`: "Группа не найдена", "Участник не найден в группе"
    -   `500 Internal Server Error`: "Не удалось удалить участника"

## Update Group Name/Details

-   **URL:** `/details` (Note: Controller function is `updateGroupName`)
-   **Method:** `PATCH`
-   **Description:** Updates the name of the group. Only the group admin can perform this action.
-   **Request Body:**
    ```json
    {
        "group_id": "uuid",
        "group_name": "string"
    }
    ```
-   **Success Response (200):**
    ```json
    {
        "group_name": "string" // The new group name
    }
    ```
    *Socket Event Emitted:* `groupUpdated` to all participants in the group's room (`GROUP<group_id>`) with full updated group details.
-   **Error Responses:**
    -   `400 Bad Request`: "group_id и непустое group_name обязательны", "Неверный формат ID группы"
    -   `401 Unauthorized`: "Пользователь не авторизован"
    -   `403 Forbidden`: "Только администратор может переименовать группу"
    -   `404 Not Found`: "Группа не найдена"
    -   `500 Internal Server Error`: "Не удалось обновить название группы"

## Fetch All Participants of a Group

-   **URL:** `/participants`
-   **Method:** `GET`
-   **Description:** Retrieves a list of all participants in a specific group. The requesting user must be a member of the group.
-   **Query Parameters:**
    -   `groupId`: `uuid` (string) - The ID of the group.
-   **Success Response (200):**
    ```json
    [
        {
            "user_id": "uuid",
            "username": "string",
            "email": "string",
            "is_online": "boolean",
            "avatarPath": "string | null",
            "role": "admin" | "member"
        }
    ]
    ```
-   **Error Responses:**
    -   `400 Bad Request`: "groupId обязателен и должен быть строкой", "Неверный формат ID группы"
    -   `401 Unauthorized`: "Пользователь не авторизован"
    -   `403 Forbidden`: "Вы не участник этой группы"
    -   `500 Internal Server Error`: "Не удалось получить участников группы"

## Mark Group Read/Unread

-   **URL:** `/read`
-   **Method:** `POST`
-   **Description:** Marks all messages in a group as read, or marks the group as unread for the authenticated user.
-   **Request Body:**
    ```json
    {
        "groupId": "uuid",
        "mark_as_unread": "boolean" // true to mark as unread, false to mark as read
    }
    ```
-   **Success Response (200):**
    ```json
    {
        "message": "Группа отмечена как непрочитанная" | "Группа отмечена как прочитанная",
        "unread_count": "integer"
    }
    ```
    *Socket Event Emitted:* `groupUpdated` to the requesting user:
    ```json
    {
        "group_id": "uuid",
        "unread_count": "integer",
        "is_muted": "boolean"
    }
    ```
-   **Error Responses:**
    -   `400 Bad Request`: "groupId обязателен", "mark_as_unread должен быть boolean", "Неверный формат ID группы"
    -   `401 Unauthorized`: "Пользователь не авторизован"
    -   `403 Forbidden`: "Вы не участник этой группы"
    -   `500 Internal Server Error`: "Ошибка при обновлении статуса прочтения группы"

## Mute/Unmute Group

-   **URL:** `/mute`
-   **Method:** `PATCH`
-   **Description:** Mutes or unmutes a group for the authenticated user.
-   **Request Body:**
    ```json
    {
        "groupId": "uuid",
        "is_muted": "boolean" // true to mute, false to unmute
    }
    ```
-   **Success Response (200):**
    ```json
    {
        "message": "Группа muted" | "Группа unmuted",
        "is_muted": "boolean"
    }
    ```
    *Socket Event Emitted:* `groupUpdated` to the requesting user (same payload as for Mark Read/Unread).
-   **Error Responses:**
    -   `400 Bad Request`: "groupId обязателен", "is_muted должен быть boolean", "Неверный формат ID группы"
    -   `401 Unauthorized`: "Пользователь не авторизован"
    -   `403 Forbidden`: "Вы не участник этой группы"
    -   `404 Not Found`: "Группа не найдена"
    -   `500 Internal Server Error`: "Ошибка при изменении статуса mute группы"

## Leave Group

-   **URL:** `/leave`
-   **Method:** `DELETE`
-   **Description:** Allows the authenticated user to leave a group. If the user is the admin and other participants remain, a new admin is assigned. If the last participant leaves, the group is deleted.
-   **Request Body:**
    ```json
    {
        "groupId": "uuid"
    }
    ```
-   **Success Response (200):**
    ```json
    {
        "message": "Вы успешно покинули группу"
    }
    ```
    *Socket Events Emitted:*
    -   `groupUpdated` to remaining participants if the group still exists, with full updated group details.
    -   `groupRemoved` to the leaving user: `{"groupId": "uuid"}`.
-   **Error Responses:**
    -   `400 Bad Request`: "groupId обязателен", "Неверный формат ID группы"
    -   `401 Unauthorized`: "Пользователь не авторизован"
    -   `403 Forbidden`: "Вы не участник этой группы"
    -   `500 Internal Server Error`: "Ошибка при выходе из группы" 