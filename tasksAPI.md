# Tasks API

This document outlines the API endpoints for managing tasks, their comments, and attachments.
All endpoints require authentication and the `Authorization: Bearer <token>` header.
The base path for these routes is `/api/tasks`.

## Common Object Structures

### Task Object
```json
{
    "id": "uuid",
    "title": "string",
    "description": "string | null",
    "status": "open" | "in_progress" | "done" | "closed",
    "priority": "integer (1-5)",
    "creator_id": "uuid",
    "creator_username": "string | null",
    "creatorAvatarPath": "string | null",
    "assignee_id": "uuid | null",
    "assignee_username": "string | null",
    "assigneeAvatarPath": "string | null",
    "due_date": "ISO8601Timestamp | null",
    "completed_at": "ISO8601Timestamp | null", // Automatically set when status changes to 'done'
    "created_at": "ISO8601Timestamp",
    "updated_at": "ISO8601Timestamp"
}
```

### Task Comment Object
```json
{
    "id": "uuid",
    "task_id": "uuid",
    "commenter_id": "uuid",
    "commenter_username": "string | null",
    "commenterAvatarPath": "string | null",
    "comment": "string",
    "created_at": "ISO8601Timestamp"
}
```

### Task Attachment Object (General)
```json
{
    "id": "uuid",
    "task_id": "uuid",
    "file_name": "string",
    "file_type": "string",
    "file_size_bytes": "integer",
    "uploaded_at": "ISO8601Timestamp",
    "uploaded_by_id": "uuid",
    "uploaded_by_username": "string | null",
    "download_url": "string" // e.g., "/api/tasks/<taskId>/attachments/download/<attachmentId>"
}
```

### Task Log Object
```json
{
    "logId": "uuid",
    "task_id": "uuid",
    "action": "string", // e.g., "Изменен статус", "Изменен исполнитель"
    "old_value": "string | null",
    "new_value": "string | null",
    "user_id": "uuid", // ID of the user who made the change
    "username": "string | null", // Username of the user who made the change
    "timestamp": "ISO8601Timestamp"
}
```

## Tasks

### Create Task

-   **URL:** `/`
-   **Method:** `POST`
-   **Description:** Creates a new task.
-   **Request Body:**
    ```json
    {
        "title": "string",
        "description": "string", // Optional
        "status": "open" | "in_progress" | "done" | "closed", // Optional, default: "open"
        "priority": "integer (1-5)", // Optional, default: 3
        "assignee_id": "uuid", // Optional
        "due_date": "ISO8601Timestamp" // Optional
    }
    ```
-   **Success Response (201):** The created [Task Object](#task-object).
    *Socket Event Emitted:* `newTaskCreated` to `general_tasks` room with the [Task Object](#task-object).
-   **Error Responses:**
    -   `400 Bad Request`: "Необходимо указать название задачи.", "Статус должен быть одним из: ...", "Приоритет должен быть от 1 до 5.", "Указанный исполнитель не найден."
    -   `500 Internal Server Error`: "Не удалось создать задачу".

### Get Tasks

-   **URL:** `/`
-   **Method:** `GET`
-   **Description:** Retrieves a list of tasks where the authenticated user is either the creator or assignee. Supports filtering and pagination.
-   **Query Parameters:**
    -   `status`: `string` (Optional, e.g., "open", "in_progress")
    -   `search`: `string` (Optional, searches in title and description)
    -   `page`: `integer` (Optional, default: 1)
    -   `limit`: `integer` (Optional, default: 10)
-   **Success Response (200):** An array of [Task Objects](#task-object).
-   **Error Responses:**
    -   `400 Bad Request`: "Неверные параметры пагинации.", "Статус должен быть одним из: ...".
    -   `403 Forbidden`: "Пользователь не аутентифицирован."
    -   `500 Internal Server Error`: "Не удалось получить список задач".

### Get Task By ID

-   **URL:** `/:taskId`
-   **Method:** `GET`
-   **Description:** Retrieves a specific task by its ID. User must be creator or assignee.
-   **URL Parameters:**
    -   `taskId`: `uuid`
-   **Success Response (200):** The [Task Object](#task-object).
-   **Error Responses:**
    -   `400 Bad Request`: "Не указан ID задачи.", "Неверный формат ID задачи."
    -   `403 Forbidden`: "Пользователь не аутентифицирован.", "Доступ к этой задаче запрещен."
    -   `404 Not Found`: "Задача не найдена."
    -   `500 Internal Server Error`: "Не удалось получить задачу".

### Update Task

-   **URL:** `/:taskId`
-   **Method:** `PUT`
-   **Description:** Updates an existing task. User must be creator or assignee. Logs changes.
-   **URL Parameters:**
    -   `taskId`: `uuid`
-   **Request Body:** (Provide only fields to update)
    ```json
    {
        "title": "string",
        "description": "string",
        "status": "open" | "in_progress" | "done" | "closed",
        "priority": "integer (1-5)",
        "assignee_id": "uuid",
        "due_date": "ISO8601Timestamp"
    }
    ```
-   **Success Response (200):** The updated [Task Object](#task-object). If no actual changes, a message is returned.
    *Socket Event Emitted:* `taskUpdated` to `task_<taskId>` room and `general_tasks` room with payload:
    ```json
    // Task Object with additional fields:
    {
        // ...Task Object fields...
        "change_details": [ // Array of log entry like structures for what changed
            { "action": "string", "old_value": "string|null", "new_value": "string|null" }
        ],
        "changed_by": {
            "user_id": "uuid",
            "username": "string | null",
            "avatarPath": "string | null"
        }
    }
    ```
-   **Error Responses:**
    -   `400 Bad Request`: Missing taskId, no data, invalid fields, invalid status/priority, "Неверный формат ID задачи или исполнителя."
    -   `403 Forbidden`: "Пользователь не аутентифицирован.", "Вы не можете обновлять эту задачу."
    -   `404 Not Found`: "Задача для обновления не найдена.", "Указанный исполнитель не найден."
    -   `500 Internal Server Error`: "Не удалось обновить задачу".

### Delete Task

-   **URL:** `/:taskId`
-   **Method:** `DELETE`
-   **Description:** Deletes a task and its associated comments, attachments, and logs. User must be creator or assignee.
-   **URL Parameters:**
    -   `taskId`: `uuid`
-   **Success Response (200):**
    ```json
    {
        "message": "Задача и все связанные данные успешно удалены.",
        "taskId": "uuid"
    }
    ```
    *Socket Event Emitted:* `taskDeleted` to `task_<taskId>` room and `general_tasks` room with payload: `{"taskId": "uuid"}`.
-   **Error Responses:**
    -   `400 Bad Request`: "Не указан ID задачи.", "Неверный формат ID задачи."
    -   `403 Forbidden`: "Пользователь не аутентифицирован.", "У вас нет прав на удаление этой задачи."
    -   `404 Not Found`: "Задача не найдена."
    -   `500 Internal Server Error`: "Не удалось удалить задачу".

## Task Comments

### Add Task Comment

-   **URL:** `/:taskId/comments`
-   **Method:** `POST`
-   **Description:** Adds a comment to a task. User must be creator or assignee of the task.
-   **URL Parameters:**
    -   `taskId`: `uuid`
-   **Request Body:**
    ```json
    {
        "comment": "string"
    }
    ```
-   **Success Response (201):** The created [Task Comment Object](#task-comment-object).
    *Socket Event Emitted:* `newTaskComment` to `task_<taskId>` room with the [Task Comment Object](#task-comment-object).
-   **Error Responses:**
    -   `400 Bad Request`: Missing taskId or comment text, "Неверный формат ID задачи."
    -   `403 Forbidden`: "Пользователь не аутентифицирован.", "Вы не можете комментировать эту задачу."
    -   `404 Not Found`: "Задача не найдена.", "Задача или пользователь не найдены."
    -   `500 Internal Server Error`: "Не удалось добавить комментарий".

### Get Task Comments

-   **URL:** `/:taskId/comments`
-   **Method:** `GET`
-   **Description:** Retrieves all comments for a specific task. User must be creator or assignee.
-   **URL Parameters:**
    -   `taskId`: `uuid`
-   **Success Response (200):** An array of [Task Comment Objects](#task-comment-object).
-   **Error Responses:**
    -   `400 Bad Request`: Missing taskId, "Неверный формат ID задачи."
    -   `403 Forbidden`: "Пользователь не аутентифицирован.", "Вы не можете просматривать комментарии к этой задаче."
    -   `404 Not Found`: "Задача не найдена."
    -   `500 Internal Server Error`: "Не удалось получить комментарии".

## Task Attachments

### Add Task Attachment

-   **URL:** `/:taskId/attachments`
-   **Method:** `POST`
-   **Content-Type:** `multipart/form-data`
-   **Description:** Uploads a file and attaches it to a task. User must be creator or assignee. Max file size 10MB.
-   **URL Parameters:**
    -   `taskId`: `uuid`
-   **Form Data Fields:**
    -   `file`: The file to upload.
-   **Success Response (201):** The created [Task Attachment Object (General)](#task-attachment-object-general).
    *Socket Event Emitted:* `newTaskAttachment` to `task_<taskId>` room with the [Task Attachment Object (General)](#task-attachment-object-general).
-   **Error Responses:**
    -   `400 Bad Request`: Missing taskId, file not uploaded, file too large, "Неверный формат ID задачи."
    -   `403 Forbidden`: "Пользователь не аутентифицирован.", "У вас нет прав добавлять вложения к этой задаче."
    -   `404 Not Found`: "Задача не найдена.", "Указана неверная задача или пользователь."
    -   `500 Internal Server Error`: "Не удалось добавить вложение".

### Get Task Attachments

-   **URL:** `/:taskId/attachments`
-   **Method:** `GET`
-   **Description:** Retrieves a list of all attachments for a specific task. User must be creator or assignee.
-   **URL Parameters:**
    -   `taskId`: `uuid`
-   **Success Response (200):** An array of [Task Attachment Objects (General)](#task-attachment-object-general).
-   **Error Responses:**
    -   `400 Bad Request`: Missing taskId, "Неверный формат ID задачи."
    -   `403 Forbidden`: "Пользователь не аутентифицирован.", "У вас нет прав на просмотр вложений этой задачи."
    -   `404 Not Found`: "Задача не найдена."
    -   `500 Internal Server Error`: "Не удалось получить вложения".

### Get Task Attachment Info

-   **URL:** `/:taskId/attachments/info/:attachmentId`
-   **Method:** `GET`
-   **Description:** Retrieves metadata for a specific task attachment. User must be creator or assignee of the task.
-   **URL Parameters:**
    -   `taskId`: `uuid`
    -   `attachmentId`: `uuid`
-   **Success Response (200):** The [Task Attachment Object (General)](#task-attachment-object-general).
-   **Error Responses:**
    -   `400 Bad Request`: Missing taskId or attachmentId, "Неверный формат ID вложения или задачи."
    -   `401 Unauthorized`: (Effectively) "Пользователь не аутентифицирован."
    -   `403 Forbidden`: "Доступ к информации о вложении запрещен."
    -   `404 Not Found`: "Вложение не найдено."
    -   `500 Internal Server Error`: "Не удалось получить информацию о вложении".

### Download Task Attachment

-   **URL:** `/:taskId/attachments/download/:attachmentId`
-   **Method:** `GET`
-   **Description:** Downloads a specific task attachment. User must be creator or assignee of the task.
-   **URL Parameters:**
    -   `taskId`: `uuid`
    -   `attachmentId`: `uuid`
-   **Success Response (200):** The file stream. Headers `Content-Type` and `Content-Disposition` will be set.
-   **Error Responses:**
    -   `400 Bad Request`: Missing attachmentId, "Неверный формат ID вложения."
    -   `401 Unauthorized`: "Пользователь не аутентифицирован."
    -   `403 Forbidden`: If user cannot access the task.
    -   `404 Not Found`: If attachment or file on disk is not found.
    -   `500 Internal Server Error`: "Не удалось скачать вложение", "Не удалось отправить файл".

### Delete Task Attachment

-   **URL:** `/:taskId/attachments/:attachmentId`
-   **Method:** `DELETE`
-   **Description:** Deletes a specific task attachment. User must be creator or assignee of the task.
-   **URL Parameters:**
    -   `taskId`: `uuid`
    -   `attachmentId`: `uuid`
-   **Success Response (200):**
    ```json
    {
        "message": "Вложение успешно удалено.",
        "attachmentId": "uuid"
    }
    ```
    *Socket Event Emitted:* `taskAttachmentDeleted` to `task_<taskId>` room with payload: `{"taskId": "uuid", "attachmentId": "uuid"}`.
-   **Error Responses:**
    -   `400 Bad Request`: Missing taskId or attachmentId, "Неверный формат ID задачи или вложения."
    -   `403 Forbidden`: "Пользователь не аутентифицирован.", "У вас нет прав на удаление вложений этой задачи."
    -   `404 Not Found`: "Задача не найдена.", "Вложение не найдено.", "Не удалось удалить вложение."
    -   `500 Internal Server Error`: "Не удалось удалить вложение".

## Task Logs

### Get Task Logs

-   **URL:** `/:taskId/logs`
-   **Method:** `GET`
-   **Description:** Retrieves activity logs for a specific task. User must be creator or assignee.
-   **URL Parameters:**
    -   `taskId`: `uuid`
-   **Success Response (200):** An array of [Task Log Objects](#task-log-object).
-   **Error Responses:**
    -   `400 Bad Request`: Missing taskId, "Неверный формат ID задачи."
    -   `403 Forbidden`: "Пользователь не аутентифицирован.", "Вы не можете просматривать логи этой задачи."
    -   `404 Not Found`: "Задача не найдена."
    -   `500 Internal Server Error`: "Не удалось получить логи".

## Task Reports

### Generate Task Report

-   **URL:** `/report`
-   **Method:** `GET`
-   **Description:** Generates a report of tasks for the authenticated user, filterable by status and date range.
-   **Query Parameters:**
    -   `status`: `string` (Optional, e.g., "open", "done")
    -   `startDate`: `ISO8601DateString` (Optional, e.g., "2023-01-01")
    -   `endDate`: `ISO8601DateString` (Optional, e.g., "2023-12-31")
-   **Success Response (200):**
    ```json
    {
        "totalTasks": "integer",
        "tasksByStatus": {
            "open": "integer",
            "in_progress": "integer",
            "done": "integer",
            "closed": "integer"
        },
        "tasks": [ // Array of Task Objects (subset based on filters)
            // ...Task Object fields...
        ],
        "generatedAt": "ISO8601Timestamp"
    }
    ```
-   **Error Responses:**
    -   `400 Bad Request`: Invalid status, invalid date format.
    -   `403 Forbidden`: "Пользователь не аутентифицирован."
    -   `500 Internal Server Error`: "Не удалось сгенерировать отчет".

## Socket Events for Tasks

-   **Client Joins Task Details View:**
    -   Client emits: `joinTaskDetails` with `taskId` (string).
    -   Server action: Joins socket to `task_<taskId>` room.
    -   Server emits to room: `taskStatus` (if task found) with `{ taskId, title, status, created_at, updated_at }`.
-   **Client Leaves Task Details View:**
    -   Client emits: `leaveTaskDetails` with `taskId` (string).
    -   Server action: Leaves socket from `task_<taskId>` room. 