-- Устанавливаем часовой пояс на московское время (UTC+3)
SET TIME ZONE 'Europe/Moscow';

-- Таблица пользователей (users)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    is_online BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    birth_date DATE,
    avatar_path VARCHAR(500) NULL
);

-- Таблица настроек пользователей (user_settings)
CREATE TABLE user_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    language VARCHAR(10) DEFAULT 'ru',
    timezone VARCHAR(50) DEFAULT 'Europe/Moscow',
    theme VARCHAR(20) DEFAULT 'light',
    show_online_status BOOLEAN DEFAULT TRUE,
    notification_preferences JSONB DEFAULT '{"email": true, "push": true}',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Таблица блокировки пользователей (user_blocks)
CREATE TABLE user_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blocker_id UUID REFERENCES users(id) ON DELETE CASCADE,
    blocked_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (blocker_id, blocked_id)
);

-- Таблица диалогов (dialogs)
CREATE TABLE dialogs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user1_id UUID REFERENCES users(id) ON DELETE CASCADE,
    user2_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user1_id, user2_id)
);

-- Таблица групп (groups)
CREATE TABLE groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    admin_id UUID REFERENCES users(id),
    avatar_path VARCHAR(500) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Таблица ролей в группах (group_roles)
CREATE TABLE group_roles (
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id)
);

-- Таблица участников диалогов (dialog_participants)
CREATE TABLE dialog_participants (
    dialog_id UUID REFERENCES dialogs(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_muted BOOLEAN DEFAULT FALSE,
    last_read_timestamp TIMESTAMP,
    notification_settings JSONB DEFAULT '{"sound": true, "vibration": true}',
    unread_count INTEGER DEFAULT 0,
    PRIMARY KEY (dialog_id, user_id)
);

-- Таблица участников групп (group_participants)
CREATE TABLE group_participants (
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_muted BOOLEAN DEFAULT FALSE,
    last_read_timestamp TIMESTAMP,
    notification_settings JSONB DEFAULT '{"sound": true, "vibration": true}',
    unread_count INTEGER DEFAULT 0,
    PRIMARY KEY (group_id, user_id)
);

-- Таблица сообщений (messages)
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dialog_id UUID REFERENCES dialogs(id) ON DELETE CASCADE,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id),
    sender_username VARCHAR(255),
    content TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    replied_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    is_edited BOOLEAN DEFAULT FALSE,
    is_forwarded BOOLEAN DEFAULT FALSE,
    forwarded_from_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    forwarded_from_username VARCHAR(255),
    original_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    is_deleted BOOLEAN DEFAULT FALSE,
    CHECK ((dialog_id IS NOT NULL AND group_id IS NULL) OR (dialog_id IS NULL AND group_id IS NOT NULL))
);

-- Таблица статусов сообщений (message_statuses)
CREATE TABLE message_statuses (
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read')),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
);

-- Таблица временных сообщений (ephemeral_messages)
CREATE TABLE ephemeral_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Таблица прочтений сообщений (message_reads)
CREATE TABLE message_reads (
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
);

-- Таблица упоминаний в сообщениях (message_mentions)
CREATE TABLE message_mentions (
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
);

-- Таблица контактов (contacts)
CREATE TABLE contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, contact_id)
);

-- Таблица файлов (files)
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    file_type VARCHAR(255),
    file_size INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Таблица уведомлений (notifications)
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    priority VARCHAR(20) DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
    related_conversation_id UUID REFERENCES dialogs(id) ON DELETE SET NULL,
    related_group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
    related_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    is_read BOOLEAN DEFAULT FALSE,
    is_dismissed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Таблица папок (folders)
CREATE TABLE folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    parent_folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Таблица связей папок с диалогами и группами (conversation_folders)
CREATE TABLE conversation_folders (
    folder_id UUID REFERENCES folders(id) ON DELETE CASCADE,
    dialog_id UUID REFERENCES dialogs(id) ON DELETE CASCADE,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (folder_id, dialog_id, group_id),
    CHECK ((dialog_id IS NOT NULL AND group_id IS NULL) OR (dialog_id IS NULL AND group_id IS NOT NULL))
);

-- Таблица задач (tasks)
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'open',
    priority INTEGER DEFAULT 3,
    creator_id UUID REFERENCES users(id) ON DELETE SET NULL,
    assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
    due_date TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Таблица логов задач (task_logs)
CREATE TABLE task_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(255) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Таблица тегов (tags)
CREATE TABLE tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) UNIQUE NOT NULL,
    color VARCHAR(7)
);

-- Таблица связей тегов и задач (task_tags)
CREATE TABLE task_tags (
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, tag_id)
);

-- Таблица для хранения токенов сброса пароля
CREATE TABLE password_resets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Таблица связей задач с диалогами и группами
CREATE TABLE task_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    dialog_id UUID REFERENCES dialogs(id) ON DELETE CASCADE,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (task_id, dialog_id, group_id),
    CHECK ((dialog_id IS NOT NULL AND group_id IS NULL) OR (dialog_id IS NULL AND group_id IS NOT NULL))
);

-- Таблица закрепленных сообщений
CREATE TABLE pinned_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dialog_id UUID REFERENCES dialogs(id) ON DELETE CASCADE,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    pinned_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
    pinned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (dialog_id, group_id),
    CHECK ((dialog_id IS NOT NULL AND group_id IS NULL) OR (dialog_id IS NULL AND group_id IS NOT NULL))
);

-- Таблица мероприятий
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    creator_id UUID REFERENCES users(id) ON DELETE SET NULL,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    dialog_id UUID REFERENCES dialogs(id) ON DELETE CASCADE,
    budget DECIMAL(15, 2),
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    location VARCHAR(255),
    status VARCHAR(50) DEFAULT 'planned',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK ((group_id IS NOT NULL AND dialog_id IS NULL) OR (group_id IS NULL AND dialog_id IS NOT NULL) OR (group_id IS NULL AND dialog_id IS NULL))
);

-- Таблица участников мероприятий
CREATE TABLE event_participants (
    event_id UUID REFERENCES events(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'invited',
    invited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, user_id)
);

-- Таблица связей мероприятий с задачами
CREATE TABLE event_tasks (
    event_id UUID REFERENCES events(id) ON DELETE CASCADE,
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, task_id)
);

-- Индексы для оптимизации
CREATE INDEX idx_dialog_participants_dialog_id ON dialog_participants(dialog_id);
CREATE INDEX idx_group_participants_group_id ON group_participants(group_id);
CREATE INDEX idx_messages_dialog_id ON messages(dialog_id);
CREATE INDEX idx_messages_group_id ON messages(group_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_sender_id ON messages(sender_id);
CREATE INDEX idx_messages_dialog_created ON messages(dialog_id, created_at);
CREATE INDEX idx_messages_group_created ON messages(group_id, created_at);
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_created_at ON notifications(created_at);
CREATE INDEX idx_notifications_is_read ON notifications(is_read);
CREATE INDEX idx_notifications_type ON notifications(type); -- Новый индекс
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX idx_tasks_due_date ON tasks(due_date);
CREATE INDEX idx_conversation_folders_folder_id ON conversation_folders(folder_id);
CREATE INDEX idx_task_tags_tag_id ON task_tags(tag_id);
CREATE INDEX idx_message_reads_message_id ON message_reads(message_id);
CREATE INDEX idx_message_mentions_message_id ON message_mentions(message_id);
CREATE INDEX idx_group_roles_group_id ON group_roles(group_id);
CREATE INDEX idx_password_resets_token ON password_resets(token);
CREATE INDEX idx_password_resets_expires_at ON password_resets(expires_at);
CREATE INDEX idx_task_conversations_task_id ON task_conversations(task_id);
CREATE INDEX idx_task_conversations_dialog_id ON task_conversations(dialog_id);
CREATE INDEX idx_task_conversations_group_id ON task_conversations(group_id);
CREATE INDEX idx_pinned_messages_dialog_id ON pinned_messages(dialog_id);
CREATE INDEX idx_pinned_messages_group_id ON pinned_messages(group_id);
CREATE INDEX idx_pinned_messages_message_id ON pinned_messages(message_id);
CREATE INDEX idx_events_creator_id ON events(creator_id);
CREATE INDEX idx_events_group_id ON events(group_id);
CREATE INDEX idx_events_dialog_id ON events(dialog_id);
CREATE INDEX idx_events_start_time ON events(start_time);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_location ON events(location); -- Новый индекс
CREATE INDEX idx_event_participants_user_id ON event_participants(user_id);
CREATE INDEX idx_event_tasks_task_id ON event_tasks(task_id);
CREATE INDEX idx_user_blocks_blocker_id ON user_blocks(blocker_id);
CREATE INDEX idx_user_blocks_blocked_id ON user_blocks(blocked_id);
CREATE INDEX idx_message_statuses_status ON message_statuses(status);
CREATE INDEX idx_ephemeral_messages_expires_at ON ephemeral_messages(expires_at);

-- Устанавливаем часовой пояс
SET TIME ZONE 'Europe/Moscow';

-- Установка имени отправителя
CREATE OR REPLACE FUNCTION set_sender_username()
RETURNS TRIGGER AS $$
BEGIN
    SELECT username INTO NEW.sender_username
    FROM users
    WHERE id = NEW.sender_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_sender_username_trigger
BEFORE INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION set_sender_username();

-- Уведомления о новом сообщении
CREATE OR REPLACE FUNCTION create_notification_on_message()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO notifications (id, user_id, type, content, priority, related_conversation_id, related_group_id, related_message_id)
    SELECT gen_random_uuid(), dp.user_id, 'new_message',
           'Новое сообщение от ' || NEW.sender_username,
           'normal',
           NEW.dialog_id, NEW.group_id, NEW.id
    FROM dialog_participants dp
    WHERE dp.dialog_id = NEW.dialog_id
      AND dp.user_id != NEW.sender_id
      AND dp.is_muted = FALSE
      AND NOT EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = dp.user_id AND blocked_id = NEW.sender_id)
    UNION
    SELECT gen_random_uuid(), gp.user_id, 'new_message',
           'Новое сообщение от ' || NEW.sender_username,
           'normal',
           NULL, NEW.group_id, NEW.id
    FROM group_participants gp
    WHERE gp.group_id = NEW.group_id
      AND gp.user_id != NEW.sender_id
      AND gp.is_muted = FALSE
      AND NOT EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = gp.user_id AND blocked_id = NEW.sender_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER create_notification_on_message_trigger
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION create_notification_on_message();

-- Обновление last_read_timestamp при прочтении сообщения
CREATE OR REPLACE FUNCTION update_last_read_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE dialog_participants
    SET last_read_timestamp = NEW.read_at
    WHERE dialog_id = (SELECT dialog_id FROM messages WHERE id = NEW.message_id)
      AND user_id = NEW.user_id;

    UPDATE group_participants
    SET last_read_timestamp = NEW.read_at
    WHERE group_id = (SELECT group_id FROM messages WHERE id = NEW.message_id)
      AND user_id = NEW.user_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_last_read_timestamp_trigger
AFTER INSERT ON message_reads
FOR EACH ROW
EXECUTE FUNCTION update_last_read_timestamp();

-- Логирование изменений задач
CREATE OR REPLACE FUNCTION log_task_changes()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.status != NEW.status THEN
            INSERT INTO task_logs (task_id, user_id, action, old_value, new_value)
            VALUES (NEW.id, NEW.assignee_id, 'status_change', OLD.status, NEW.status);
        END IF;
        IF OLD.description IS DISTINCT FROM NEW.description THEN
            INSERT INTO task_logs (task_id, user_id, action, old_value, new_value)
            VALUES (NEW.id, NEW.assignee_id, 'description_change', OLD.description, NEW.description);
        END IF;
        IF OLD.due_date IS DISTINCT FROM NEW.due_date THEN
            INSERT INTO task_logs (task_id, user_id, action, old_value, new_value)
            VALUES (NEW.id, NEW.assignee_id, 'due_date_change', OLD.due_date::TEXT, NEW.due_date::TEXT);
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER log_task_changes_trigger
AFTER UPDATE ON tasks
FOR EACH ROW
EXECUTE FUNCTION log_task_changes();

-- Автоматическое создание диалога при добавлении контакта
CREATE OR REPLACE FUNCTION create_dialog_on_contact()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM dialogs
        WHERE (user1_id = NEW.user_id AND user2_id = NEW.contact_id)
           OR (user1_id = NEW.contact_id AND user2_id = NEW.user_id)
    ) THEN
        INSERT INTO dialogs (user1_id, user2_id)
        VALUES (NEW.user_id, NEW.contact_id);
        
        INSERT INTO dialog_participants (dialog_id, user_id)
        SELECT id, NEW.user_id FROM dialogs WHERE user1_id = NEW.user_id AND user2_id = NEW.contact_id
        UNION
        SELECT id, NEW.contact_id FROM dialogs WHERE user1_id = NEW.user_id AND user2_id = NEW.contact_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER create_dialog_on_contact_trigger
AFTER INSERT ON contacts
FOR EACH ROW
EXECUTE FUNCTION create_dialog_on_contact();

-- Уведомления о назначении задачи
CREATE OR REPLACE FUNCTION notify_task_assignment()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'INSERT' AND NEW.assignee_id IS NOT NULL) OR 
       (TG_OP = 'UPDATE' AND NEW.assignee_id IS NOT NULL AND OLD.assignee_id IS DISTINCT FROM NEW.assignee_id) THEN
        INSERT INTO notifications (id, user_id, type, content, priority, related_message_id)
        VALUES (gen_random_uuid(), NEW.assignee_id, 'task_assigned',
                'Вам назначена задача: ' || NEW.title, 'high', NULL);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_task_assignment_trigger
AFTER INSERT OR UPDATE ON tasks
FOR EACH ROW
EXECUTE FUNCTION notify_task_assignment();

-- Обновление unread_count при добавлении сообщения
CREATE OR REPLACE FUNCTION update_unread_count_on_message()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.dialog_id IS NOT NULL THEN
        UPDATE dialog_participants
        SET unread_count = unread_count + 1
        WHERE dialog_id = NEW.dialog_id 
          AND user_id != NEW.sender_id
          AND NOT EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = user_id AND blocked_id = NEW.sender_id);
    ELSIF NEW.group_id IS NOT NULL THEN
        UPDATE group_participants
        SET unread_count = unread_count + 1
        WHERE group_id = NEW.group_id 
          AND user_id != NEW.sender_id
          AND NOT EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = user_id AND blocked_id = NEW.sender_id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_unread_count_on_message_trigger
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION update_unread_count_on_message();

-- Сброс unread_count при прочтении сообщения
CREATE OR REPLACE FUNCTION reset_unread_count_on_read()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM messages WHERE id = NEW.message_id AND dialog_id IS NOT NULL) THEN
        UPDATE dialog_participants
        SET unread_count = 0
        WHERE dialog_id = (SELECT dialog_id FROM messages WHERE id = NEW.message_id)
          AND user_id = NEW.user_id;
    ELSIF EXISTS (SELECT 1 FROM messages WHERE id = NEW.message_id AND group_id IS NOT NULL) THEN
        UPDATE group_participants
        SET unread_count = 0
        WHERE group_id = (SELECT group_id FROM messages WHERE id = NEW.message_id)
          AND user_id = NEW.user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reset_unread_count_on_read_trigger
AFTER INSERT ON message_reads
FOR EACH ROW
EXECUTE FUNCTION reset_unread_count_on_read();

-- Обновление updated_at в таблице users
CREATE OR REPLACE FUNCTION update_user_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_user_updated_at_trigger
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_user_updated_at();

-- Обновление updated_at в таблице tasks
CREATE OR REPLACE FUNCTION update_task_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_task_updated_at_trigger
BEFORE UPDATE ON tasks
FOR EACH ROW
EXECUTE FUNCTION update_task_updated_at();

-- Уведомления о добавлении в группу
CREATE OR REPLACE FUNCTION notify_group_add()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO notifications (id, user_id, type, content, priority, related_group_id)
    VALUES (
        gen_random_uuid(),
        NEW.user_id,
        'group_add',
        'Вас добавили в группу ' || (SELECT name FROM groups WHERE id = NEW.group_id),
        'normal',
        NEW.group_id
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_group_add_trigger
AFTER INSERT ON group_participants
FOR EACH ROW
EXECUTE FUNCTION notify_group_add();

-- Уведомления о создании задачи
CREATE OR REPLACE FUNCTION notify_task_creation()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.creator_id IS NOT NULL AND NEW.assignee_id IS NOT NULL AND NEW.creator_id != NEW.assignee_id THEN
        INSERT INTO notifications (id, user_id, type, content, priority, related_message_id)
        VALUES (
            gen_random_uuid(),
            NEW.assignee_id,
            'task_created',
            'Создана новая задача: ' || NEW.title || ' от ' || (SELECT username FROM users WHERE id = NEW.creator_id),
            'high',
            NULL
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_task_creation_trigger
AFTER INSERT ON tasks
FOR EACH ROW
EXECUTE FUNCTION notify_task_creation();

-- Уведомления о прикреплении задачи
CREATE OR REPLACE FUNCTION notify_task_attached_to_conversation()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.dialog_id IS NOT NULL THEN
        INSERT INTO notifications (id, user_id, type, content, priority, related_conversation_id, related_message_id)
        SELECT gen_random_uuid(), dp.user_id, 'task_attached',
               'Задача "' || (SELECT title FROM tasks WHERE id = NEW.task_id) || '" прикреплена к диалогу',
               'normal',
               NEW.dialog_id, NULL
        FROM dialog_participants dp
        WHERE dp.dialog_id = NEW.dialog_id
          AND dp.is_muted = FALSE;
    ELSIF NEW.group_id IS NOT NULL THEN
        INSERT INTO notifications (id, user_id, type, content, priority, related_group_id, related_message_id)
        SELECT gen_random_uuid(), gp.user_id, 'task_attached',
               'Задача "' || (SELECT title FROM tasks WHERE id = NEW.task_id) || '" прикреплена к группе',
               'normal',
               NEW.group_id, NULL
        FROM group_participants gp
        WHERE gp.group_id = NEW.group_id
          AND gp.is_muted = FALSE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_task_attached_to_conversation_trigger
AFTER INSERT ON task_conversations
FOR EACH ROW
EXECUTE FUNCTION notify_task_attached_to_conversation();

-- Уведомления о закреплении сообщения
CREATE OR REPLACE FUNCTION notify_message_pinned()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.dialog_id IS NOT NULL THEN
        INSERT INTO notifications (id, user_id, type, content, priority, related_conversation_id, related_message_id)
        SELECT gen_random_uuid(), dp.user_id, 'message_pinned',
               'Сообщение от ' || (SELECT sender_username FROM messages WHERE id = NEW.message_id) || ' закреплено в диалоге',
               'normal',
               NEW.dialog_id, NEW.message_id
        FROM dialog_participants dp
        WHERE dp.dialog_id = NEW.dialog_id
          AND dp.user_id != NEW.pinned_by_id
          AND dp.is_muted = FALSE;
    ELSIF NEW.group_id IS NOT NULL THEN
        INSERT INTO notifications (id, user_id, type, content, priority, related_group_id, related_message_id)
        SELECT gen_random_uuid(), gp.user_id, 'message_pinned',
               'Сообщение от ' || (SELECT sender_username FROM messages WHERE id = NEW.message_id) || ' закреплено в группе',
               'normal',
               NEW.group_id, NEW.message_id
        FROM group_participants gp
        WHERE gp.group_id = NEW.group_id
          AND gp.user_id != NEW.pinned_by_id
          AND gp.is_muted = FALSE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_message_pinned_trigger
AFTER INSERT ON pinned_messages
FOR EACH ROW
EXECUTE FUNCTION notify_message_pinned();

-- Уведомления об откреплении сообщения
CREATE OR REPLACE FUNCTION notify_message_unpinned()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.dialog_id IS NOT NULL THEN
        INSERT INTO notifications (id, user_id, type, content, priority, related_conversation_id, related_message_id)
        SELECT gen_random_uuid(), dp.user_id, 'message_unpinned',
               'Сообщение от ' || (SELECT sender_username FROM messages WHERE id = OLD.message_id) || ' откреплено в диалоге',
               'normal',
               OLD.dialog_id, OLD.message_id
        FROM dialog_participants dp
        WHERE dp.dialog_id = OLD.dialog_id
          AND dp.is_muted = FALSE;
    ELSIF OLD.group_id IS NOT NULL THEN
        INSERT INTO notifications (id, user_id, type, content, priority, related_group_id, related_message_id)
        SELECT gen_random_uuid(), gp.user_id, 'message_unpinned',
               'Сообщение от ' || (SELECT sender_username FROM messages WHERE id = OLD.message_id) || ' откреплено в группе',
               'normal',
               OLD.group_id, OLD.message_id
        FROM group_participants gp
        WHERE gp.group_id = OLD.group_id
          AND gp.is_muted = FALSE;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_message_unpinned_trigger
AFTER DELETE ON pinned_messages
FOR EACH ROW
EXECUTE FUNCTION notify_message_unpinned();

-- Уведомления о приглашении на мероприятие
CREATE OR REPLACE FUNCTION notify_event_invitation()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO notifications (id, user_id, type, content, priority, related_group_id, related_conversation_id, related_message_id)
    SELECT gen_random_uuid(), ep.user_id, 'event_invitation',
           'Приглашение на мероприятие: ' || (SELECT title FROM events WHERE id = NEW.event_id),
           'high',
           (SELECT group_id FROM events WHERE id = NEW.event_id),
           (SELECT dialog_id FROM events WHERE id = NEW.event_id),
           NULL
    FROM event_participants ep
    WHERE ep.event_id = NEW.event_id
      AND ep.user_id != (SELECT creator_id FROM events WHERE id = NEW.event_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_event_invitation_trigger
AFTER INSERT ON event_participants
FOR EACH ROW
EXECUTE FUNCTION notify_event_invitation();

-- Уведомления о статусе мероприятия
CREATE OR REPLACE FUNCTION notify_event_status_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status != NEW.status THEN
        INSERT INTO notifications (id, user_id, type, content, priority, related_group_id, related_conversation_id, related_message_id)
        SELECT gen_random_uuid(), ep.user_id, 'event_status_changed',
               'Статус мероприятия "' || NEW.title || '" изменен на ' || NEW.status,
               'normal',
               NEW.group_id, NEW.dialog_id, NULL
        FROM event_participants ep
        WHERE ep.event_id = NEW.id
          AND ep.status != 'declined';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_event_status_change_trigger
AFTER UPDATE ON events
FOR EACH ROW
EXECUTE FUNCTION notify_event_status_change();

-- Обновление updated_at для мероприятий
CREATE OR REPLACE FUNCTION update_event_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_event_updated_at_trigger
BEFORE UPDATE ON events
FOR EACH ROW
EXECUTE FUNCTION update_event_updated_at();

-- Нормализация порядка user1_id и user2_id в dialogs
CREATE OR REPLACE FUNCTION normalize_dialog_users()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user1_id > NEW.user2_id THEN
        NEW.user1_id = NEW.user2_id;
        NEW.user2_id = NEW.user1_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER normalize_dialog_users_trigger
BEFORE INSERT ON dialogs
FOR EACH ROW
EXECUTE FUNCTION normalize_dialog_users();

-- Очистка старых уведомлений
CREATE OR REPLACE FUNCTION cleanup_old_notifications()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM notifications
    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days'
      AND is_read = TRUE
      AND is_dismissed = TRUE;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cleanup_old_notifications_trigger
AFTER INSERT ON notifications
FOR EACH ROW
EXECUTE FUNCTION cleanup_old_notifications();

-- Обновление статуса сообщения
CREATE OR REPLACE FUNCTION update_message_status()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO message_statuses (message_id, user_id, status, updated_at)
    VALUES (NEW.message_id, NEW.user_id, 'read', NEW.read_at)
    ON CONFLICT (message_id, user_id)
    DO UPDATE SET status = 'read', updated_at = NEW.read_at;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_message_status_trigger
AFTER INSERT ON message_reads
FOR EACH ROW
EXECUTE FUNCTION update_message_status();

-- Автоматическое удаление временных сообщений
CREATE OR REPLACE FUNCTION delete_expired_ephemeral_messages()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE messages
    SET is_deleted = TRUE
    WHERE id = NEW.message_id
      AND EXISTS (
          SELECT 1 FROM ephemeral_messages
          WHERE message_id = NEW.message_id
            AND expires_at <= CURRENT_TIMESTAMP
      );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER delete_expired_ephemeral_messages_trigger
AFTER INSERT OR UPDATE ON ephemeral_messages
FOR EACH ROW
EXECUTE FUNCTION delete_expired_ephemeral_messages();