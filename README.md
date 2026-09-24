# Azure OpenAI Vector Store tools

Набор CLI-скриптов для работы с Azure OpenAI Vector Stores.

Скрипты используют уже существующие Azure files. При копировании файлы не скачиваются и не загружаются заново.

Требуется Node.js 18 или новее.

## Установка и запуск

Установка зависимостей не требуется. Запуск выполняется из корня проекта:

```bash
npm run copy
```

или:

```bash
npm run clean
```

Azure endpoint можно заранее задать через переменную окружения:

```powershell
$env:AZURE_OPENAI_ENDPOINT = "https://your-resource.openai.azure.com"
```

## Копирование файлов

Команда:

```bash
npm run copy
```

Скрипт запрашивает:

1. Azure OpenAI endpoint;
2. Azure API key/token;
3. список source vector store IDs через запятую;
4. destination vector store ID.

Порядок работы:

1. Читаются файлы source stores и destination store.
2. Проверяется существование каждого Azure file через `GET /files/{file_id}`.
3. Файлы, которые уже есть в destination, пропускаются.
4. Одинаковые `file_id` из нескольких source stores обрабатываются один раз.
5. Удаленные Azure files, оставшиеся привязанными к source store, пропускаются.
6. Создается dry-run report без attach-запросов.
7. После подтверждения `YES` выполняется attach файлов.
8. Для каждого файла ожидается завершение индексации.

Проблемный статус vector-store file сам по себе не является причиной пропуска: решение принимается по существованию самого Azure file.

## Очистка vector store

### Удаление только привязок

```bash
npm run clean
```

Этот режим удаляет файлы из vector store, но сохраняет сами Azure files. Используйте его, если файлы могут понадобиться в другом vector store.

### Удаление привязок и самих Azure files

```bash
npm run clean -- --delete-files
```

Этот режим сначала удаляет файл из vector store, а затем выполняет окончательное удаление Azure file через `DELETE /files/{file_id}`.

Удаление самих Azure files необратимо. Флаг `--delete-files` нужно указывать явно.

Оба режима очистки:

1. Получают полный список файлов vector store.
2. Создают dry-run report.
3. Показывают количество файлов и список операций.
4. Не отправляют DELETE-запросы до явного ввода `YES`.
5. Обрабатывают файлы по одному и продолжают работу после ошибки отдельного файла.

## Логи и отчеты

Для каждой операции создаются два файла в каталоге `logs/`.

### Operational log

Файлы имеют имена:

```text
copy-....log
clean-....log
```

В них записываются:

- каждый HTTP-запрос;
- HTTP status и длительность запроса;
- retry и сетевые ошибки;
- attach/unattach/delete операции;
- ошибки отдельных файлов;
- финальный результат.

API key в логах не сохраняется.

### Человекочитаемый report

Файлы имеют имена:

```text
report-....txt
clean-report-....txt
```

В них находятся dry-run summary, группировка по source store или список очищаемых файлов, а также итог выполнения.

Во время индексации copy-скрипт показывает текущий Azure status в консоли:

```text
Indexing: in_progress | elapsed 00:06
Indexing: completed   | elapsed 00:12
```

## Безопасность и повторный запуск

- Скрипт копирования идемпотентен относительно destination.
- Повторный запуск очистки безопасен для уже удаленных attachments, но режим `--delete-files` может окончательно удалить сами Azure files.
- Перед production-запуском всегда проверяйте dry-run report.
- Не добавляйте API key в командную строку: он запрашивается интерактивно.
