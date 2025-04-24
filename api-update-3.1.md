# API и WebSocket: Обновления v3.1 (VKA Chat NG)

Этот документ описывает изменения и дополнения в API и WebSocket протоколе для клиента VKA Chat NG.

## 1. Сообщения

### 1.1. Отправка Сообщения (с Ответом)

*   **Направление:** Клиент -> Сервер
*   **Событие WebSocket:** `sendMessage`
*   **Данные (Payload):**
    ```json
    {
      "conversation_id": "uuid-чата",
      "sender_id": "uuid-отправителя", // Должен совпадать с ID авторизованного пользователя
      "content": "Текст нового сообщения...", // Опционально, если есть file_id
      "file_id": "uuid-файла", // Опционально
      "mentions": ["uuid-упомянутого-1", "..."], // Опционально
      "replied_to_message_id": "uuid-сообщения-на-которое-ответ" // Опционально, UUID исходного сообщения
    }
    ```
    *   **Новое:** Поле `replied_to_message_id` для указания ответа на сообщение.
    *   **Валидация:**
        *   `conversation_id`, `sender_id` обязательны.
        *   Хотя бы одно из полей `content` или `file_id` должно присутствовать.
        *   Если `replied_to_message_id` указан, сообщение с таким ID должно существовать в данном `conversation_id`.

### 1.2. Получение Нового Сообщения

*   **Направление:** Сервер -> Клиент
*   **Событие WebSocket:** `newMessage`
*   **Данные (Payload):**
    ```json
    {
      "id": "uuid-нового-сообщения",
      "conversation_id": "uuid-чата",
      "sender_id": "uuid-отправителя",
      "sender_username": "Имя отправителя",
      "content": "Текст нового сообщения...",
      "created_at": "iso-timestamp", // Время создания UTC (ISO 8601)
      "is_edited": false,
      "files": [
        {
          "id": "uuid-файла",
          "file_name": "имя.расширение",
          "file_path": "/uploads/путь/к/файлу", // Не для прямого доступа
          "file_type": "image/jpeg", // MIME-тип
          "file_size": 123456, // Размер в байтах
          "created_at": "iso-timestamp",
          "download_url": "/api/files/download/uuid-файла" // URL для скачивания
        }
      ],
      "read_by_users": [
        {
          "contact_id": "uuid-прочитавшего",
          "username": "Имя прочитавшего",
          "email": "email@example.com",
          "read_at": "iso-timestamp"
        }
      ],
      "is_unread": true, // Клиентский флаг (для всех, кроме отправителя)
      // --- Поля ответа --- 
      "replied_to_message_id": "uuid-исходного-сообщения", // NULL, если не ответ
      "replied_to_sender_username": "Имя автора исходного", // NULL, если не ответ
      "replied_to_content_preview": "Краткое превью..." // NULL, если не ответ
    }
    ```
    *   **Новое:** Поля `is_edited`, `replied_to_message_id`, `replied_to_sender_username`, `replied_to_content_preview`.

### 1.3. Редактирование Сообщения

*   **Направление:** Клиент -> Сервер
*   **Метод:** `PATCH`
*   **Путь:** `/messages/`
*   **Заголовки:**
    *   `Authorization: Bearer <your_token>`
    *   `Content-Type: application/json`
*   **Тело Запроса (JSON):**
    ```json
    {
      "messageId": "uuid-редактируемого-сообщения",
      "content": "Новый текст сообщения..."
    }
    ```
*   **Ответ (Успех 200 OK):** Полный объект сообщения (структура как в п.1.2 `newMessage`).
*   **Ответ (Ошибка):** `400` (нет `messageId` / `content`), `401`, `403` (не автор), `404` (нет сообщения), `500`.

### 1.4. Обновление Сообщения (событие)

*   **Направление:** Сервер -> Клиент (в комнату чата)
*   **Событие WebSocket:** `messageUpdated`
*   **Данные (Payload):**
    ```json
    {
      "id": "uuid-отредактированного-сообщения",
      "conversation_id": "uuid-чата",
      "content": "Новый текст сообщения...",
      "is_edited": true
    }
    ```

### 1.5. Удаление Сообщения

*   **Направление:** Клиент -> Сервер
*   **Метод:** `DELETE`
*   **Путь:** `/messages/`
*   **Заголовки:**
    *   `Authorization: Bearer <your_token>`
    *   `Content-Type: application/json`
*   **Тело Запроса (JSON):**
    ```json
    {
      "messageId": "uuid-удаляемого-сообщения"
    }
    ```
*   **Ответ (Успех 204 No Content):** Нет тела ответа.
*   **Ответ (Ошибка):** `400` (нет `messageId`), `401`, `403` (не автор), `404` (нет сообщения, но сервер может вернуть 204), `500`.

### 1.6. Сообщение Удалено (событие)

*   **Направление:** Сервер -> Клиент (в комнату чата)
*   **Событие WebSocket:** `messageDeleted`
*   **Данные (Payload):**
    ```json
    {
      "id": "uuid-удаленного-сообщения",
      "conversation_id": "uuid-чата"
    }
    ```

### 1.7. Обновление Статуса Прочтения Сообщения (конкретное)

*   **Направление:** Сервер -> Клиент (в комнату чата)
*   **Событие WebSocket:** `messageReadUpdate`
*   **Данные (Payload):**
    ```json
    {
      "conversation_id": "uuid-чата",
      "message_id": "uuid-прочитанного-сообщения",
      "user_id": "uuid-прочитавшего-пользователя",
      "read_at": "iso-timestamp"
    }
    ```
    *   Используется для обновления массива `read_by_users` у конкретного сообщения.

## 2. Чаты

### 2.1. Получение Списка Чатов

*   **Направление:** Клиент -> Сервер
*   **Метод:** `GET`
*   **Путь:** `/conversations/`
*   **Заголовки:** `Authorization: Bearer <your_token>`
*   **Ответ (Успех 200 OK):** Массив объектов чатов:
    ```json
    [
      {
        "conversation_id": "uuid-чата",
        "conversation_name": "Имя диалога / Название группы",
        "is_group_chat": false, // или true
        "group_name": "Название группы", // Оригинальное имя (для групп)
        "admin_name": "Имя админа", // NULL, если админ удален
        "admin_id": "uuid-админа",
        "last_message": "Текст последнего сообщения...", // NULL, если нет сообщений
        "last_message_time": "iso-timestamp", // NULL, если нет сообщений
        "last_message_sender_id": "uuid-отправителя", // NULL, если нет сообщений
        "last_message_sender_username": "Имя отправителя", // NULL, если нет сообщений
        "unread_count": 5, // Количество непрочитанных сообщений (считается по last_read_timestamp)
        "is_muted": false, // Замьючен ли чат ТЕКУЩИМ пользователем?
        "last_read_timestamp": "iso-timestamp", // Время последнего прочтения ТЕКУЩИМ пользователем (NULL, если не читал / отмечен непрочитанным)
        "participants": [ // Массив участников
          {
            "user_id": "uuid-участника",
            "username": "Имя участника",
            "email": "email@example.com",
            "is_online": true
          }
        ],
        "conversation_created_at": "iso-timestamp"
      }
    ]
    ```
    *   **Новое/Измененное:**
        *   `unread_count`: Теперь считается на основе `last_read_timestamp`.
        *   `is_muted`: Статус Mute для текущего пользователя.
        *   `last_read_timestamp`: Время последнего прочтения для текущего пользователя.

### 2.2. Отметка Прочитанного / Непрочитанного

*   **Направление:** Клиент -> Сервер
*   **Метод:** `POST`
*   **Путь:** `/conversations/:conversationId/read`
*   **Заголовки:** `Authorization: Bearer <your_token>`, `Content-Type: application/json`
*   **Тело Запроса (JSON):**
    ```json
    {
      "mark_as_unread": false // false - прочитано, true - непрочитано
    }
    ```
*   **Ответ (Успех 200 OK):**
    ```json
    {
      "id": "uuid-чата"
    }
    ```
*   **Ответ (Ошибка):** `400`, `401`, `404` (чат/участник не найден), `500`.

### 2.3. Включение / Выключение Уведомлений (Mute)

*   **Направление:** Клиент -> Сервер
*   **Метод:** `PATCH`
*   **Путь:** `/conversations/:conversationId/mute`
*   **Заголовки:** `Authorization: Bearer <your_token>`, `Content-Type: application/json`
*   **Тело Запроса (JSON):**
    ```json
    {
      "is_muted": true // true - включить Mute, false - выключить
    }
    ```
*   **Ответ (Успех 200 OK):**
    ```json
    {
      "id": "uuid-чата",
      "is_muted": true // Новый статус
    }
    ```
*   **Ответ (Ошибка):** `400`, `401`, `404` (чат/участник не найден), `500`.

### 2.4. Выход из Группы

*   **Направление:** Клиент -> Сервер
*   **Метод:** `DELETE`
*   **Путь:** `/conversations/:conversationId/participants/me`
*   **Заголовки:** `Authorization: Bearer <your_token>`
*   **Ответ (Успех 204 No Content):** Нет тела ответа.
*   **Ответ (Ошибка):** `400` (не группа), `401`, `403` (не участник), `404` (чат не найден), `500`.

### 2.5. Удаление Диалога

*   **Направление:** Клиент -> Сервер
*   **Метод:** `DELETE`
*   **Путь:** `/conversations/:conversationId`
*   **Заголовки:** `Authorization: Bearer <your_token>`
*   **Ответ (Успех 204 No Content):** Нет тела ответа.
*   **Ответ (Ошибка):** `401`, `403` (не участник / это группа), `404` (чат не найден), `500`.

## 3. Общие События WebSocket для Чатов

### 3.1. Обновление Информации о Чате

*   **Направление:** Сервер -> Клиент (конкретному пользователю)
*   **Событие WebSocket:** `conversationUpdated`
*   **Данные (Payload):** Содержит `id` чата и измененные поля.
    *   При Mute/Unmute:
        ```json
        {"id": "uuid-чата", "is_muted": true}
        ```
    *   При Read/Unread:
        ```json
        {"id": "uuid-чата", "last_read_timestamp": "iso-timestamp | null"}
        ```
    *   **Действия клиента:** Обновить соответствующие поля в локальной модели чата. Пересчитать `unread_count` на основе нового `last_read_timestamp` (если применимо).

### 3.2. Пользователь Покинул Группу

*   **Направление:** Сервер -> Клиент (всем оставшимся участникам в комнату чата)
*   **Событие WebSocket:** `userLeftGroup`
*   **Данные (Payload):**
    ```json
    {
      "conversation_id": "uuid-чата",
      "user_id": "uuid-пользователя-который-вышел"
    }
    ```

### 3.3. Чат (Диалог) Удален

*   **Направление:** Сервер -> Клиент (пользователю, инициировавшему удаление)
*   **Событие WebSocket:** `conversationDeleted`
*   **Данные (Payload):**
    ```json
    {
      "id": "uuid-удаленного-чата"
    }
    ```

--- 