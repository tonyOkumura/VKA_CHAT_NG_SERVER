-- Устанавливаем часовой пояс на московское время (UTC+3).
-- Это значит, что все временные метки (например, когда создано сообщение) будут в московском времени.
SET TIME ZONE 'Europe/Moscow';

-- Таблица users: здесь хранятся данные о пользователях мессенджера.
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Уникальный идентификатор пользователя (UUID — это длинный случайный код, который никогда не повторяется).
    username VARCHAR(255) UNIQUE NOT NULL, -- Имя пользователя (до 50 символов), должно быть уникальным (нельзя зарегистрировать два одинаковых имени).
    email VARCHAR(100) UNIQUE NOT NULL, -- Электронная почта пользователя (до 100 символов), тоже должна быть уникальной.
    password VARCHAR(255) NOT NULL, -- Пароль пользователя (до 255 символов), обязателен.
    is_online BOOLEAN DEFAULT FALSE, -- Статус: онлайн (TRUE) или офлайн (FALSE). По умолчанию пользователь офлайн.
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- Время создания аккаунта (автоматически ставится текущее московское время).
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP -- Время последнего обновления аккаунта (например, если пользователь сменил пароль).
);

-- Таблица conversations: здесь хранятся все чаты (личные и групповые).
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Уникальный идентификатор чата.
    name VARCHAR(100), -- Название чата (например, "Друзья" для группового чата). Для личных чатов может быть пустым (NULL).
    is_group_chat BOOLEAN DEFAULT FALSE, -- Это групповой чат? TRUE — да, FALSE — нет (личный чат между двумя людьми).
    admin_id UUID REFERENCES users(id), -- Кто администратор чата (ссылка на пользователя из таблицы users). Обычно это создатель чата.
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP -- Время создания чата (московское время).
);

-- Таблица conversation_participants: связывает пользователей и чаты (кто в каком чате состоит).
-- Это нужно, чтобы поддерживать групповые чаты, где может быть больше двух участников.
CREATE TABLE conversation_participants (
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE, -- Идентификатор чата (ссылка на таблицу conversations). Если чат удаляется, запись тоже удаляется (ON DELETE CASCADE).
    user_id UUID REFERENCES users(id) ON DELETE CASCADE, -- Идентификатор пользователя (ссылка на таблицу users). Если пользователь удаляется, запись тоже удаляется.
    unread_count INTEGER DEFAULT 0, -- Сколько непрочитанных сообщений у этого пользователя в этом чате. По умолчанию 0.
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- Время, когда пользователь присоединился к чату (московское время).
    PRIMARY KEY (conversation_id, user_id) -- Уникальная комбинация: один пользователь может быть в одном чате только один раз.
);

-- Таблица messages: здесь хранятся все сообщения в чатах.
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Уникальный идентификатор сообщения.
    conversation_id UUID REFERENCES conversations(id), -- В каком чате это сообщение (ссылка на таблицу conversations).
    sender_id UUID REFERENCES users(id), -- Кто отправил сообщение (ссылка на таблицу users).
    sender_username VARCHAR(255), -- Имя отправителя на момент отправки сообщения
    content TEXT, -- Текст сообщения (может быть любой длины, например, "Привет, как дела?").
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP -- Время отправки сообщения (московское время).
);

-- Таблица message_reads: отслеживает, кто именно прочитал сообщение.
-- Это нужно, чтобы в групповом чате видеть, кто из участников прочитал сообщение.
CREATE TABLE message_reads (
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE, -- Идентификатор сообщения (ссылка на таблицу messages). Если сообщение удаляется, запись тоже удаляется.
    user_id UUID REFERENCES users(id) ON DELETE CASCADE, -- Кто прочитал сообщение (ссылка на таблицу users). Если пользователь удаляется, запись тоже удаляется.
    read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- Время, когда сообщение было прочитано (московское время).
    PRIMARY KEY (message_id, user_id) -- Уникальная комбинация: один пользователь может прочитать одно сообщение только один раз.
);

-- Таблица message_mentions: хранит упоминания пользователей в сообщениях (например, @username).
-- Это нужно, чтобы отправлять уведомления тем, кого упомянули.
CREATE TABLE message_mentions (
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE, -- Идентификатор сообщения, где есть упоминание.
    user_id UUID REFERENCES users(id) ON DELETE CASCADE, -- Кого упомянули (ссылка на таблицу users).
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- Время упоминания (московское время).
    PRIMARY KEY (message_id, user_id) -- Уникальная комбинация: одного пользователя можно упомянуть в одном сообщении только один раз.
);

-- Таблица contacts: хранит список контактов пользователя (кто у кого в друзьях).
CREATE TABLE IF NOT EXISTS contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Уникальный идентификатор записи.
    user_id UUID REFERENCES users(id) ON DELETE CASCADE, -- Чей это контакт (ссылка на таблицу users).
    contact_id UUID REFERENCES users(id) ON DELETE CASCADE, -- Кто добавлен в контакты (ссылка на таблицу users).
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- Время добавления контакта (московское время).
    UNIQUE (user_id, contact_id) -- Уникальная комбинация: нельзя добавить одного и того же пользователя в контакты дважды.
);

-- Таблица files: хранит файлы, прикреплённые к сообщениям (например, фото, видео, документы).
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Уникальный идентификатор файла.
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE, -- К какому сообщению прикреплён файл (если сообщение удаляется, файл тоже удаляется).
    file_name VARCHAR(255) NOT NULL, -- Имя файла (например, "photo.jpg").
    file_path VARCHAR(500) NOT NULL, -- Путь к файлу на сервере или в облаке (например, "/uploads/photo.jpg").
    file_type VARCHAR(255), -- Тип файла (например, "image", "video", "document").
    file_size INTEGER, -- Размер файла в байтах (например, 5242880 для 5 МБ).
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP -- Время загрузки файла (московское время).
);

-- Таблица notifications: хранит уведомления для пользователей (например, о новых сообщениях).
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Уникальный идентификатор уведомления.
    user_id UUID REFERENCES users(id) ON DELETE CASCADE, -- Кому адресовано уведомление (ссылка на таблицу users).
    type VARCHAR(255) NOT NULL, -- Тип уведомления: 'new_message' (новое сообщение), 'mention' (упоминание), 'group_add' (добавление в чат).
    content TEXT NOT NULL, -- Текст уведомления (например, "Новое сообщение от user123").
    related_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL, -- Ссылка на чат, связанный с уведомлением (может стать NULL, если чат удалён).
    related_message_id UUID REFERENCES messages(id) ON DELETE SET NULL, -- Ссылка на сообщение, связанное с уведомлением (может стать NULL, если сообщение удалено).
    is_read BOOLEAN DEFAULT FALSE, -- Прочитано ли уведомление? FALSE — нет, TRUE — да.
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP -- Время создания уведомления (московское время).
);

-- Триггер: увеличивает счётчик непрочитанных сообщений, когда добавляется новое сообщение.
-- Например, если user1 отправляет сообщение в чат, у всех остальных участников этого чата увеличивается счётчик.
CREATE OR REPLACE FUNCTION increase_unread_count()
RETURNS TRIGGER AS $$
BEGIN
    -- Увеличиваем unread_count для всех участников чата, кроме отправителя.
    UPDATE conversation_participants
    SET unread_count = unread_count + 1
    WHERE conversation_id = NEW.conversation_id
      AND user_id != NEW.sender_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER increase_unread_count_trigger
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION increase_unread_count();

-- Триггер: уменьшает счётчик непрочитанных сообщений, когда пользователь прочитал сообщение.
-- Например, если user2 прочитал сообщение, его счётчик уменьшается.
CREATE OR REPLACE FUNCTION decrease_unread_count()
RETURNS TRIGGER AS $$
BEGIN
    -- Уменьшаем unread_count для пользователя, который прочитал сообщение.
    UPDATE conversation_participants
    SET unread_count = GREATEST(unread_count - 1, 0) -- GREATEST не даёт счётчику стать меньше 0.
    WHERE conversation_id = (SELECT conversation_id FROM messages WHERE id = NEW.message_id)
      AND user_id = NEW.user_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER decrease_unread_count_trigger
AFTER INSERT ON message_reads
FOR EACH ROW
EXECUTE FUNCTION decrease_unread_count();

-- Триггер: создаёт уведомление, когда добавляется новое сообщение.
-- Например, если user1 отправляет сообщение, все остальные участники чата получают уведомление.
CREATE OR REPLACE FUNCTION create_notification_on_message()
RETURNS TRIGGER AS $$
BEGIN
    -- Создаём уведомление для всех участников чата, кроме отправителя.
    INSERT INTO notifications (id, user_id, type, content, related_conversation_id, related_message_id)
    SELECT gen_random_uuid(), cp.user_id, 'new_message',
           'Новое сообщение от ' || (SELECT username FROM users WHERE id = NEW.sender_id),
           NEW.conversation_id, NEW.id
    FROM conversation_participants cp
    WHERE cp.conversation_id = NEW.conversation_id
      AND cp.user_id != NEW.sender_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER create_notification_on_message_trigger
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION create_notification_on_message();

-- Триггер: создаёт уведомление, когда пользователя упомянули в сообщении.
-- Например, если в сообщении написали @user2, user2 получит уведомление.
CREATE OR REPLACE FUNCTION create_mention_notification()
RETURNS TRIGGER AS $$
BEGIN
    -- Создаём уведомление для упомянутого пользователя.
    INSERT INTO notifications (id, user_id, type, content, related_conversation_id, related_message_id)
    VALUES (
        gen_random_uuid(),
        NEW.user_id,
        'mention',
        'Вас упомянули в сообщении от ' || (SELECT username FROM users WHERE id = (SELECT sender_id FROM messages WHERE id = NEW.message_id)),
        (SELECT conversation_id FROM messages WHERE id = NEW.message_id),
        NEW.message_id
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER create_mention_notification_trigger
AFTER INSERT ON message_mentions
FOR EACH ROW
EXECUTE FUNCTION create_mention_notification();

-- Триггер: создаёт уведомление, когда пользователя добавляют в групповой чат.
-- Например, если user1 добавили в чат "Друзья", он получит уведомление.
CREATE OR REPLACE FUNCTION create_group_add_notification()
RETURNS TRIGGER AS $$
BEGIN
    -- Создаём уведомление для добавленного пользователя.
    INSERT INTO notifications (id, user_id, type, content, related_conversation_id)
    VALUES (
        gen_random_uuid(),
        NEW.user_id,
        'group_add',
        'Вас добавили в чат ' || (SELECT name FROM conversations WHERE id = NEW.conversation_id),
        NEW.conversation_id
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER create_group_add_notification_trigger
AFTER INSERT ON conversation_participants
FOR EACH ROW
EXECUTE FUNCTION create_group_add_notification();

CREATE OR REPLACE FUNCTION add_reverse_contact()
RETURNS TRIGGER AS $$
BEGIN
    -- Проверяем, существует ли уже обратная запись (чтобы избежать дубликатов)
    IF NOT EXISTS (
        SELECT 1 FROM contacts 
        WHERE user_id = NEW.contact_id 
          AND contact_id = NEW.user_id
    ) THEN
        -- Создаём обратную запись
        INSERT INTO contacts (user_id, contact_id, created_at)
        VALUES (NEW.contact_id, NEW.user_id, CURRENT_TIMESTAMP);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Создаём триггер, который срабатывает после вставки новой записи в `contacts`
CREATE TRIGGER add_reverse_contact_trigger
AFTER INSERT ON contacts
FOR EACH ROW
EXECUTE FUNCTION add_reverse_contact();

-- Индексы: ускоряют поиск данных в таблицах.
-- Это как оглавление в книге — помогает быстрее найти нужную информацию.
CREATE INDEX idx_conversation_participants_conversation_id ON conversation_participants(conversation_id); -- Для быстрого поиска участников по чату.
CREATE INDEX idx_conversation_participants_user_id ON conversation_participants(user_id); -- Для быстрого поиска чатов пользователя.
CREATE INDEX idx_messages_conversation_id ON messages(conversation_id); -- Для быстрого поиска сообщений в чате.
CREATE INDEX idx_messages_sender_id ON messages(sender_id); -- Для быстрого поиска сообщений от конкретного пользователя.
CREATE INDEX idx_message_reads_message_id ON message_reads(message_id); -- Для быстрого поиска, кто прочитал сообщение.
CREATE INDEX idx_message_reads_user_id ON message_reads(user_id); -- Для быстрого поиска сообщений, прочитанных пользователем.
CREATE INDEX idx_message_mentions_message_id ON message_mentions(message_id); -- Для быстрого поиска упоминаний в сообщении.
CREATE INDEX idx_notifications_user_id ON notifications(user_id); -- Для быстрого поиска уведомлений пользователя.

-- Функция для автоматического заполнения sender_username при создании сообщения
CREATE OR REPLACE FUNCTION set_sender_username()
RETURNS TRIGGER AS $$
BEGIN
    -- Получаем username отправителя из таблицы users
    SELECT username INTO NEW.sender_username
    FROM users
    WHERE id = NEW.sender_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Создаём триггер, который срабатывает перед вставкой нового сообщения
CREATE TRIGGER set_sender_username_trigger
BEFORE INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION set_sender_username();

-- ======================================
-- Дополнения для функционала таск-трекера
-- ======================================

-- 1. Таблица задач
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),       -- Уникальный идентификатор задачи
    title VARCHAR(255) NOT NULL,                          -- Краткое название задачи
    description TEXT,                                     -- Подробное описание задачи
    status VARCHAR(50) DEFAULT 'open',                    -- Статус задачи (например, open, in_progress, done, canceled)
    priority INTEGER DEFAULT 3,                           -- Приоритет задачи (например, 1 – высокий, 5 – низкий)
    creator_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- Кто создал задачу
    assignee_id UUID REFERENCES users(id) ON DELETE SET NULL, -- Исполнитель задачи
    due_date TIMESTAMP,                                   -- Срок выполнения задачи
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,       -- Время создания задачи (московское время)
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP        -- Время последнего обновления задачи (московское время)
);

-- 2. Таблица комментариев к задачам
CREATE TABLE task_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),       -- Уникальный идентификатор комментария
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,  -- Ссылка на задачу, к которой оставлен комментарий
    commenter_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- Пользователь, оставивший комментарий
    comment TEXT NOT NULL,                                -- Текст комментария
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP        -- Время оставления комментария (московское время)
);

-- 3. Таблица файлов (вложений) к задачам
CREATE TABLE task_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),       -- Уникальный идентификатор файла
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,  -- Ссылка на задачу, к которой прикреплён файл
    file_name VARCHAR(255) NOT NULL,                      -- Имя файла
    file_path VARCHAR(500) NOT NULL,                      -- Путь к файлу на сервере или в облаке
    file_type VARCHAR(255),                               -- Тип файла (например, image, document и т.д.)
    file_size INTEGER,                                    -- Размер файла в байтах
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP        -- Время загрузки файла (московское время)
);

-- 4. Таблица логов изменений (истории задач)
CREATE TABLE task_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),       -- Уникальный идентификатор записи логов
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,  -- Ссылка на задачу
    action VARCHAR(100) NOT NULL,                         -- Тип изменения (например, смена статуса, изменение приоритета)
    old_value VARCHAR(255),                               -- Старое значение поля (если применимо)
    new_value VARCHAR(255),                               -- Новое значение поля (если применимо)
    changed_by UUID REFERENCES users(id) ON DELETE SET NULL,  -- Пользователь, инициировавший изменение
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP        -- Время изменения (московское время)
);

-- 5. Триггер для автоматического обновления поля updated_at при изменении задачи

-- Функция обновления поля updated_at
CREATE OR REPLACE FUNCTION update_task_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Триггер для таблицы tasks
CREATE TRIGGER update_task_updated_at_trigger
BEFORE UPDATE ON tasks
FOR EACH ROW
EXECUTE FUNCTION update_task_updated_at();

-- 6. Дополнительные индексы для ускорения выборок по задачам
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX idx_tasks_due_date ON tasks(due_date);

-- ======================================
-- Конец дополнений для таск-трекера
-- ======================================