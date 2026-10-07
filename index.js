#!/usr/bin/env node
import { Command, Argument, Option } from "commander";
import { readFileSync, existsSync } from "node:fs";

// ---------- Допоміжні функції ----------

/** Друкує повідомлення про помилку українською та завершує програму з кодом 1. */
function fail(message) {
  console.error(`Помилка: ${message}`);
  process.exit(1);
}

/** Зчитує та парсить JSON-файл розкладу, обробляючи типові помилки. */
function loadData(filePath) {
  if (!existsSync(filePath)) {
    fail(`файл "${filePath}" не знайдено.`);
  }
  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    fail(`не вдалося прочитати файл "${filePath}" (${err.message}).`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`файл "${filePath}" містить некоректний JSON (${err.message}).`);
  }
}

/** Повертає масив { dayOfWeek, lesson } для всіх занять документа (обхід вкладених масивів). */
function flattenLessons(data) {
  const result = [];
  for (const day of data.days ?? []) {
    for (const lesson of day.lessons ?? []) {
      result.push({ dayOfWeek: day.dayOfWeek, lesson });
    }
  }
  return result;
}

/** Короткий текстовий опис викладача: "доцент Бойко Я. В." або "не вказано". */
function teacherLabel(teacher) {
  if (teacher == null) return "не вказано";
  const rank = teacher.academicRank ? `${teacher.academicRank} ` : "";
  return `${rank}${teacher.fullName}`;
}

/** Один рядок стислого переліку заняття. */
function lessonSummaryLine({ dayOfWeek, lesson }) {
  const parity = lesson.weekParity ? ` [${lesson.weekParity}]` : "";
  const remote = lesson.isRemote ? " (дистанційно)" : "";
  return `${dayOfWeek}, пара ${lesson.pairNumber} (${lesson.time})${parity} — ${lesson.subject} (${lesson.lessonType})${remote}`;
}

/** Повний, багаторядковий опис одного заняття з усіма полями. */
function lessonFullText({ dayOfWeek, lesson }) {
  const lines = [
    `День: ${dayOfWeek}`,
    `Пара: ${lesson.pairNumber} (${lesson.time})`,
    `Підгрупа: ${lesson.subgroup ?? "не вказано (null)"}`,
    `Дисципліна: ${lesson.subject}`,
    `Тип заняття: ${lesson.lessonType}`,
    `Викладач: ${teacherLabel(lesson.teacher)}`,
    `Аудиторія: ${lesson.room}`,
    `Дистанційно: ${lesson.isRemote ? "так" : "ні"}`,
    `Тиждень: ${lesson.weekParity ?? "щотижня (null)"}`,
  ];
  if ("department" in lesson) lines.push(`Кафедра: ${lesson.department}`);
  if ("note" in lesson) lines.push(`Примітка: ${lesson.note}`);
  return lines.join("\n");
}

/**
 * Знаходить заняття за днем тижня й номером пари. Якщо на цю пару припадає
 * кілька занять (чергування за weekParity), а parity не вказано — повертає
 * усі знайдені записи, щоб викликач міг або показати їх, або повідомити
 * про потребу уточнення.
 */
function findLessons(data, dayOfWeek, pairNumber, parity) {
  const day = data.days?.find((d) => d.dayOfWeek === dayOfWeek);
  if (!day) {
    const available = (data.days ?? []).map((d) => d.dayOfWeek).join(", ");
    fail(`день "${dayOfWeek}" не знайдено в розкладі. Доступні дні: ${available}.`);
  }
  let matches = day.lessons.filter((l) => l.pairNumber === pairNumber);
  if (matches.length === 0) {
    fail(`пару №${pairNumber} не знайдено в дні "${dayOfWeek}".`);
  }
  if (parity) {
    matches = matches.filter((l) => l.weekParity === parity);
    if (matches.length === 0) {
      fail(`на пару №${pairNumber} у дні "${dayOfWeek}" з тижнем "${parity}" нічого не знайдено.`);
    }
  }
  return matches.map((lesson) => ({ dayOfWeek, lesson }));
}

/**
 * Читає значення поля за шляхом через крапку (підтримує вкладені об'єкти).
 * Явно розрізняє три випадки, щоб повідомлення про помилку було точним:
 *  - found: true          — поле знайдено (значення може бути й null);
 *  - reason: "missing"    — на цьому кроці шляху такого ключа немає;
 *  - reason: "null-parent"— проміжний об'єкт дорівнює null, тому спускатися
 *                           далі по шляху неможливо (напр. teacher.academicRank,
 *                           коли сам teacher — null).
 */
function getByPath(obj, path) {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (current === null) {
      return { found: false, reason: "null-parent", atPart: parts.slice(0, i).join(".") };
    }
    if (typeof current !== "object" || !(part in current)) {
      return { found: false, reason: "missing", atPart: parts.slice(0, i + 1).join(".") };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

/** Форматує значення поля для виводу: об'єкти — у вигляді JSON, null — рядком "null". */
function formatFieldValue(value) {
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/** Перетворює ціле число з перевіркою; при помилці завершує програму. */
function parsePairNumber(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    fail(`номер пари має бути додатним цілим числом, отримано "${value}".`);
  }
  return n;
}

// ---------- Опис програми ----------

const program = new Command();

program
  .name("schedule-cli")
  .description(
    "CLI-програма для роботи з розкладом занять групи (JSON-документ з ЛР1)."
  )
  .version("1.0.0", "-v, --version", "показати версію програми")
  .option("-f, --file <path>", "шлях до JSON-файлу розкладу", "data.json")
  .addHelpText(
    "after",
    `
Приклади:
  $ node index.js list --limit 5
  $ node index.js show Понеділок 1
  $ node index.js field Понеділок 1 teacher.academicRank
  $ node index.js day Вівторок
  $ node index.js teacher Бойко --remote-only
  $ node index.js parity чисельник`
  )
  .exitOverride(); // перехоплюємо помилки commander самі, замість process.exit напряму

// ---------- Частина 3. Загальні можливості ----------

program
  .command("list")
  .description("показати стислий перелік занять")
  .option("-l, --limit <n>", "обмежити кількість виведених занять", (v) => parsePairNumber(v))
  .action((opts) => {
    const data = loadData(program.opts().file);
    let items = flattenLessons(data);
    if (opts.limit) items = items.slice(0, opts.limit);
    if (items.length === 0) {
      console.log("Заняття не знайдено.");
      return;
    }
    console.log(`Розклад групи ${data.groupName}, ${data.subgroup}:`);
    items.forEach((item) => console.log("  " + lessonSummaryLine(item)));
  });

program
  .command("show")
  .description("показати одне заняття цілком")
  .addArgument(new Argument("<day>", "день тижня, напр. Понеділок"))
  .addArgument(new Argument("<pair>", "номер пари"))
  .addArgument(
    new Argument("[parity]", "тиждень, якщо на пару припадає кілька занять").choices([
      "чисельник",
      "знаменник",
    ])
  )
  .action((day, pair, parity) => {
    const data = loadData(program.opts().file);
    const pairNumber = parsePairNumber(pair);
    const matches = findLessons(data, day, pairNumber, parity);
    if (matches.length > 1) {
      console.log(
        `На ${day}, пару №${pairNumber} припадає ${matches.length} заняття залежно від тижня. Уточніть тиждень:`
      );
      matches.forEach((m) => console.log("  " + lessonSummaryLine(m)));
      process.exitCode = 1;
      return;
    }
    console.log(lessonFullText(matches[0]));
  });

program
  .command("field")
  .description("показати значення окремого поля заняття (підтримує вкладені поля через крапку)")
  .addArgument(new Argument("<day>", "день тижня"))
  .addArgument(new Argument("<pair>", "номер пари"))
  .addArgument(new Argument("<path>", "шлях до поля, напр. teacher.academicRank"))
  .addArgument(
    new Argument("[parity]", "тиждень, якщо на пару припадає кілька занять").choices([
      "чисельник",
      "знаменник",
    ])
  )
  .action((day, pair, path, parity) => {
    const data = loadData(program.opts().file);
    const pairNumber = parsePairNumber(pair);
    const matches = findLessons(data, day, pairNumber, parity);
    if (matches.length > 1) {
      console.log(
        `На ${day}, пару №${pairNumber} припадає ${matches.length} заняття залежно від тижня. Уточніть тиждень (чисельник/знаменник).`
      );
      process.exitCode = 1;
      return;
    }
    const result = getByPath(matches[0].lesson, path);
    if (!result.found) {
      if (result.reason === "null-parent") {
        fail(
          `неможливо отримати "${path}": проміжне поле "${result.atPart}" має значення null, тому вкладених полів у ньому немає.`
        );
      }
      fail(`поле "${result.atPart}" відсутнє в цьому занятті.`);
    }
    console.log(formatFieldValue(result.value));
  });

// ---------- Частина 4. Можливості варіанта (розклад занять) ----------

program
  .command("day")
  .description("показати всі заняття обраного дня тижня")
  .addArgument(new Argument("<dayOfWeek>", "день тижня, напр. Вівторок"))
  .action((dayOfWeek) => {
    const data = loadData(program.opts().file);
    const day = data.days?.find((d) => d.dayOfWeek === dayOfWeek);
    if (!day) {
      const available = (data.days ?? []).map((d) => d.dayOfWeek).join(", ");
      fail(`день "${dayOfWeek}" не знайдено. Доступні дні: ${available}.`);
    }
    console.log(`${dayOfWeek} (${day.lessons.length} заняття):`);
    day.lessons.forEach((lesson) =>
      console.log("  " + lessonSummaryLine({ dayOfWeek, lesson }))
    );
  });

program
  .command("teacher")
  .description("показати заняття обраного викладача (частковий пошук за іменем)")
  .addArgument(new Argument("<name>", "повне ім'я або фрагмент, напр. Бойко"))
  .option("--remote-only", "показати лише дистанційні заняття", false)
  .action((name, opts) => {
    const data = loadData(program.opts().file);
    const needle = name.toLowerCase();
    let items = flattenLessons(data).filter(
      (item) =>
        item.lesson.teacher && item.lesson.teacher.fullName.toLowerCase().includes(needle)
    );
    if (opts.remoteOnly) {
      items = items.filter((item) => item.lesson.isRemote);
    }
    if (items.length === 0) {
      console.log(`Заняття викладача "${name}" не знайдено${opts.remoteOnly ? " (серед дистанційних)" : ""}.`);
      return;
    }
    console.log(`Заняття викладача "${name}" (${items.length}):`);
    items.forEach((item) => console.log("  " + lessonSummaryLine(item)));
  });

program
  .command("parity")
  .description("показати розклад за чисельником або знаменником (разом із щотижневими заняттями)")
  .addArgument(new Argument("<value>", "тиждень").choices(["чисельник", "знаменник"]))
  .action((value) => {
    const data = loadData(program.opts().file);
    // щотижневі заняття (weekParity === null) входять в обидва варіанти тижня
    const items = flattenLessons(data).filter(
      (item) => item.lesson.weekParity === value || item.lesson.weekParity === null
    );
    console.log(`Розклад на тиждень "${value}" (${items.length} занять, разом із щотижневими):`);
    items.forEach((item) => console.log("  " + lessonSummaryLine(item)));
  });

// ---------- Запуск програми з перехопленням помилок commander ----------

// Переклад типових кодів помилок commander на українську — самі коди
// стабільні (частина публічного API commander), а текст повідомлення ні,
// тому ми формуємо власну коротку фразу, а деталі (яка саме опція/аргумент)
// додаємо з оригінального err.message.
const COMMANDER_ERROR_MESSAGES = {
  "commander.missingArgument": "пропущено обов'язковий аргумент.",
  "commander.unknownOption": "невідома опція.",
  "commander.unknownCommand": "невідома команда.",
  "commander.invalidArgument": "неприпустиме значення аргументу.",
  "commander.excessArguments": "забагато аргументів.",
  "commander.missingMandatoryOptionValue": "не вказано значення обов'язкової опції.",
};

try {
  program.parse(process.argv);
} catch (err) {
  // Власні помилки (fail()) уже викликали process.exit(1) до цього блоку.
  // Сюди потрапляють лише помилки самого commander: невідома команда/опція,
  // пропущений обов'язковий аргумент, неприпустиме значення аргументу тощо.
  if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
    process.exit(0);
  }
  const prefix = COMMANDER_ERROR_MESSAGES[err.code] ?? "некоректний виклик програми.";
  console.error(`Помилка: ${prefix} (${err.message})`);
  process.exit(err.exitCode && err.exitCode !== 0 ? err.exitCode : 1);
}
