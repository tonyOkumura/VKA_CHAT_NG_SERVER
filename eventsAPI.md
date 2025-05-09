# Events API

This document outlines the API endpoints for managing events and their participants.
All endpoints require authentication and the `Authorization: Bearer <token>` header.
The base path for these routes is `/api/events`.

## Common Object Structures

### Event Object (Full Details)
Returned by `GET /:eventId` and `POST /` (on creation).
```json
{
    "id": "uuid",
    "title": "string",
    "description": "string | null",
    "creator_id": "uuid",
    "creator_username": "string | null",
    "creator_avatar_path": "string | null",
    "group_id": "uuid | null", // ID of linked group, if any
    "dialog_id": "uuid | null", // ID of linked dialog, if any
    "budget": "number | null", // Stored as DECIMAL in DB
    "start_time": "ISO8601Timestamp",
    "end_time": "ISO8601Timestamp",
    "location": "string | null",
    "status": "planned" | "ongoing" | "completed" | "cancelled",
    "created_at": "ISO8601Timestamp",
    "updated_at": "ISO8601Timestamp",
    "participants": [
        {
            "user_id": "uuid",
            "username": "string",
            "avatarPath": "string | null",
            "status": "invited" | "accepted" | "declined" | "maybe"
        }
    ]
}
```

### Event Object (List View)
Returned by `GET /`.
```json
{
    "id": "uuid",
    "title": "string",
    "description": "string | null",
    "creator_id": "uuid",
    "creator_username": "string | null",
    "creator_avatar_path": "string | null",
    "group_id": "uuid | null",
    "dialog_id": "uuid | null",
    "budget": "number | null",
    "start_time": "ISO8601Timestamp",
    "end_time": "ISO8601Timestamp",
    "location": "string | null",
    "status": "planned" | "ongoing" | "completed" | "cancelled",
    "created_at": "ISO8601Timestamp",
    "updated_at": "ISO8601Timestamp"
    // Note: Participants list not included in the general list view by default
}
```

### Event Participant Object
Returned by `GET /:eventId/participants` and `POST /:eventId/participants`.
```json
{
    "user_id": "uuid",
    "username": "string",
    "email": "string", // Included in GET list
    "avatarPath": "string | null",
    "is_online": "boolean", // Included in GET list
    "status": "invited" | "accepted" | "declined" | "maybe",
    "invited_at": "ISO8601Timestamp" // Included in GET list
}
```

## Events CRUD

### Create Event

-   **URL:** `/`
-   **Method:** `POST`
-   **Description:** Creates a new event. The creator is automatically added as a participant with 'accepted' status.
-   **Request Body:**
    ```json
    {
        "title": "string",
        "description": "string", // Optional
        "group_id": "uuid", // Optional, links event to a group
        "dialog_id": "uuid", // Optional, links event to a dialog (cannot use with group_id)
        "budget": "number", // Optional
        "start_time": "ISO8601Timestamp", // Required
        "end_time": "ISO8601Timestamp", // Required
        "location": "string", // Optional
        "status": "planned" | "ongoing" | "completed" | "cancelled", // Optional, default: "planned"
        "participant_ids": ["uuid"] // Optional array of user IDs to invite initially (status: 'invited')
    }
    ```
-   **Success Response (201):** The created [Event Object (Full Details)](#event-object-full-details).
-   **Socket Events Emitted:**
    -   `newEvent` to the creator (Payload: Full Event Details).
    -   `eventInvitation` to each user in `participant_ids` (Payload: Full Event Details).
    -   `newEventInGroup` to the linked group room (if `group_id` provided). Payload: `{ eventId, title, groupId }`.
    -   `newEventInDialog` to the participants of the linked dialog (if `dialog_id` provided). Payload: `{ eventId, title, dialogId }`.
-   **Error Responses:**
    -   `400 Bad Request`: Missing required fields, invalid status, invalid date format, cannot link to group and dialog simultaneously, error linking to group/dialog/user.
    -   `401 Unauthorized`: "Пользователь не авторизован".
    -   `404 Not Found`: If linked group/dialog/participant user not found.
    -   `500 Internal Server Error`: "Не удалось создать событие".

### Get Events

-   **URL:** `/`
-   **Method:** `GET`
-   **Description:** Retrieves a list of events where the authenticated user is the creator or a participant.
-   **Query Parameters:** (TODO: Implement filtering)
    -   `status`: `string`
    -   `startDate`: `ISO8601DateString`
    -   `endDate`: `ISO8601DateString`
-   **Success Response (200):** An array of [Event Objects (List View)](#event-object-list-view).
-   **Error Responses:**
    -   `401 Unauthorized`: "Пользователь не авторизован".
    -   `500 Internal Server Error`: "Не удалось получить события".

### Get Event By ID

-   **URL:** `/:eventId`
-   **Method:** `GET`
-   **Description:** Retrieves full details for a specific event, including participants. User must be creator or participant.
-   **URL Parameters:**
    -   `eventId`: `uuid`
-   **Success Response (200):** The [Event Object (Full Details)](#event-object-full-details).
-   **Error Responses:**
    -   `400 Bad Request`: "Не указан ID события", "Неверный формат ID события".
    -   `401 Unauthorized`: "Пользователь не авторизован".
    -   `403 Forbidden`: "Доступ к этому событию запрещен".
    -   `404 Not Found`: "Событие не найдено".
    -   `500 Internal Server Error`: "Не удалось получить событие".

### Update Event

-   **URL:** `/:eventId`
-   **Method:** `PUT`
-   **Description:** Updates details of an existing event. Currently, only the creator can update.
-   **URL Parameters:**
    -   `eventId`: `uuid`
-   **Request Body:** (Provide only fields to update)
    ```json
    {
        "title": "string",
        "description": "string",
        "budget": "number",
        "start_time": "ISO8601Timestamp",
        "end_time": "ISO8601Timestamp",
        "location": "string",
        "status": "planned" | "ongoing" | "completed" | "cancelled"
    }
    ```
-   **Success Response (200):** The updated [Event Object (Full Details)](#event-object-full-details).
-   **Socket Events Emitted:**
    -   `eventUpdated` to all current participants (Payload: Full Event Details).
    -   `eventUpdatedInGroup` / `eventUpdatedInDialog` to linked group/dialog room (Payload: Full Event Details).
-   **Error Responses:**
    -   `400 Bad Request`: Missing eventId, no data, invalid fields, invalid status/date format, start time after end time.
    -   `401 Unauthorized`: "Пользователь не авторизован".
    -   `403 Forbidden`: "Только создатель может редактировать событие".
    -   `404 Not Found`: "Событие не найдено".
    -   `500 Internal Server Error`: "Не удалось обновить событие".

### Delete Event

-   **URL:** `/:eventId`
-   **Method:** `DELETE`
-   **Description:** Deletes an event and removes all participants. Currently, only the creator can delete.
-   **URL Parameters:**
    -   `eventId`: `uuid`
-   **Success Response (200):**
    ```json
    {
        "message": "Событие успешно удалено",
        "eventId": "uuid"
    }
    ```
-   **Socket Events Emitted:**
    -   `eventDeleted` to all former participants. Payload: `{ eventId }`.
    -   `eventDeletedInGroup` / `eventDeletedInDialog` to linked group/dialog room. Payload: `{ eventId }`.
-   **Error Responses:**
    -   `400 Bad Request`: Missing eventId, "Неверный формат ID события".
    -   `401 Unauthorized`: "Пользователь не авторизован".
    -   `403 Forbidden`: "Только создатель может удалить событие".
    -   `404 Not Found`: "Событие не найдено".
    -   `500 Internal Server Error`: "Не удалось удалить событие".

## Event Participants Management

### Add Event Participant

-   **URL:** `/:eventId/participants`
-   **Method:** `POST`
-   **Description:** Adds a user to an event as a participant (typically with 'invited' status). Currently, only the event creator can add participants.
-   **URL Parameters:**
    -   `eventId`: `uuid`
-   **Request Body:**
    ```json
    {
        "user_id_to_add": "uuid",
        "status": "invited" | "accepted" | "declined" | "maybe" // Optional, default: "invited"
    }
    ```
-   **Success Response (201):** Details of the newly added participant.
    ```json
    {
        "event_id": "uuid",
        "user_id": "uuid",
        "username": "string",
        "avatarPath": "string | null",
        "status": "string"
    }
    ```
-   **Socket Events Emitted:**
    -   `eventParticipantAdded` to all *other* current participants. Payload: `{ eventId, participant: { event_id, user_id, username, avatarPath, status } }`.
    -   `eventInvitation` to the newly added user (`user_id_to_add`). Payload: Full Event Details.
-   **Error Responses:**
    -   `400 Bad Request`: Missing eventId or user_id_to_add, invalid status, "Неверный формат ID события или пользователя".
    -   `401 Unauthorized`: "Пользователь не авторизован".
    -   `403 Forbidden`: "Только создатель может приглашать участников".
    -   `404 Not Found`: "Событие не найдено", "Приглашаемый пользователь не найден".
    -   `409 Conflict`: "Пользователь уже является участником события".
    -   `500 Internal Server Error`: "Не удалось добавить участника к событию".

### Get Event Participants

-   **URL:** `/:eventId/participants`
-   **Method:** `GET`
-   **Description:** Retrieves a list of participants for a specific event. User must be creator or participant.
-   **URL Parameters:**
    -   `eventId`: `uuid`
-   **Success Response (200):** An array of [Event Participant Objects](#event-participant-object).
-   **Error Responses:**
    -   `400 Bad Request`: Missing eventId, "Неверный формат ID события".
    -   `401 Unauthorized`: "Пользователь не авторизован".
    -   `403 Forbidden`: "Доступ к участникам этого события запрещен".
    -   `404 Not Found`: "Событие не найдено".
    -   `500 Internal Server Error`: "Не удалось получить участников события".

### Update Event Participant Status

-   **URL:** `/:eventId/participants/:participantUserId`
-   **Method:** `PUT`
-   **Description:** Updates the status of a participant in an event (e.g., accepting/declining invitation). Can be done by the participant themselves or the event creator.
-   **URL Parameters:**
    -   `eventId`: `uuid`
    -   `participantUserId`: `uuid` (The ID of the user whose status is being updated)
-   **Request Body:**
    ```json
    {
        "status": "invited" | "accepted" | "declined" | "maybe" // Required
    }
    ```
-   **Success Response (200):**
    ```json
    {
        "message": "Статус участника успешно обновлен",
        "eventId": "uuid",
        "userId": "uuid",
        "newStatus": "string"
    }
    ```
-   **Socket Events Emitted:**
    -   `eventParticipantStatusUpdated` to all current participants. Payload: `{ eventId, userId, newStatus, username, avatarPath }`.
-   **Error Responses:**
    -   `400 Bad Request`: Missing IDs or status, invalid status, "Неверный формат ID события или пользователя".
    -   `401 Unauthorized`: "Пользователь не авторизован".
    -   `403 Forbidden`: "У вас нет прав на изменение статуса этого участника".
    -   `404 Not Found`: "Событие не найдено", "Участник не найден в этом событии".
    -   `500 Internal Server Error`: "Не удалось обновить статус участника".

### Remove Event Participant / Leave Event

-   **URL:** `/:eventId/participants/:participantUserId`
-   **Method:** `DELETE`
-   **Description:** Removes a participant from an event. Can be done by the participant themselves (leaving) or the event creator (removing). The creator cannot leave their own event this way (must delete the event).
-   **URL Parameters:**
    -   `eventId`: `uuid`
    -   `participantUserId`: `uuid` (The ID of the user being removed)
-   **Success Response (200):**
    ```json
    {
        "message": "Участник успешно удален/вышел из события",
        "eventId": "uuid",
        "userId": "uuid"
    }
    ```
-   **Socket Events Emitted:**
    -   `eventParticipantRemoved` to remaining participants. Payload: `{ eventId, userId }`.
    -   `removedFromEvent` to the removed participant. Payload: `{ eventId }`.
-   **Error Responses:**
    -   `400 Bad Request`: Missing IDs, "Создатель не может покинуть событие этим способом. Используйте удаление события.", "Неверный формат ID события или пользователя".
    -   `401 Unauthorized`: "Пользователь не авторизован".
    -   `403 Forbidden`: "У вас нет прав на удаление этого участника".
    -   `404 Not Found`: "Событие не найдено", "Участник не найден в этом событии".
    -   `500 Internal Server Error`: "Не удалось удалить участника". 