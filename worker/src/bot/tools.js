/* Инструменты бота: create_lead (заявка менеджеру) и handoff (позвать менеджера).
   strict: true — API гарантирует, что аргументы совпадут со схемой. Все поля обязательны,
   неизвестное бот передаёт пустой строкой. */

const str = (description) => ({ type: "string", description });

export const TOOLS = [
  {
    name: "create_lead",
    description: "Передать менеджеру заявку на созвон или встречу. Вызывай, когда посетитель дал имя и контакт и согласен, "
      + "чтобы с ним связались. Если заявка уже создана, а посетитель сообщил новое (время созвона, имя, другой контакт, важный вопрос), "
      + "вызови снова: менеджеру уйдёт дополнение к заявке. Без вызова менеджер новые данные НЕ увидит. "
      + "Поля, которые не выяснил, оставь пустой строкой.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "contact", "contact_type", "niche", "current_channel", "pain", "positions", "deadline",
        "tariff", "objections", "meeting", "temperature", "summary"],
      properties: {
        name: str("Имя посетителя"),
        contact: str("Номер WhatsApp или телефона, либо @username в Telegram, как дал посетитель"),
        contact_type: { type: "string", enum: ["whatsapp", "telegram", "phone"], description: "Как связаться" },
        niche: str("Что продаёт или какие услуги, своими словами"),
        current_channel: str("Как сейчас принимает заказы или запись: директ, WhatsApp, звонки, Taplink и т.п."),
        pain: str("Главная боль своими словами"),
        positions: str("Примерно сколько позиций: до 30, до 100, больше 100, не считали"),
        deadline: str("Срок или повод: праздник, сезон, запуск рекламы"),
        tariff: { type: "string", enum: ["start", "magazin", "pro", "other", "unknown"], description: "Тариф, который обсуждали" },
        objections: str("Возражения и вопросы, которые остались"),
        meeting: str("Созвон или встреча и удобное время, как сказал посетитель"),
        temperature: { type: "string", enum: ["warm", "hot"], description: "hot: сам просит созвон, есть срок, согласен с ценой «от»" },
        summary: str("Коротко для менеджера: о чём договорились и с чего начать разговор"),
      },
    },
  },
  {
    name: "handoff",
    description: "Позвать менеджера: вопроса нет в базе знаний, сложный запрос, жалоба, просьба живого человека, "
      + "торг, скидка, рассрочка. Перед вызовом попроси контакт, если его ещё нет.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["reason", "question", "contact"],
      properties: {
        reason: { type: "string", enum: ["not_in_knowledge", "custom_request", "complaint", "wants_human", "price_talk", "other"] },
        question: str("Суть вопроса для менеджера"),
        contact: str("Контакт посетителя, если дал; иначе пустая строка"),
      },
    },
  },
];

/** Выполняет вызов инструмента. actions — побочные эффекты (запись заявки, сообщение в группу). */
export async function runTool(block, { session, actions, store }) {
  const input = block.input ?? {};
  try {
    if (block.name === "create_lead") {
      if (session.lead_id) {
        await actions.updateLead(input, session);
        return { content: `Дополнение к заявке №${session.lead_id} отправлено менеджеру.` };
      }
      if (!String(input.contact ?? "").trim() && !session.tg_id) {
        return { content: "Нет контакта: попроси номер WhatsApp или Telegram и вызови снова.", is_error: true };
      }
      const { id } = await actions.createLead(input, session);
      session.lead_id = id;
      await store.saveSession(session);
      return { content: `Заявка №${id} передана менеджеру.`, lead: true };
    }
    if (block.name === "handoff") {
      await actions.handoff(input, session);
      return { content: "Вопрос передан менеджеру." };
    }
    return { content: `Неизвестный инструмент ${block.name}`, is_error: true };
  } catch (e) {
    console.error(`Инструмент ${block.name}:`, e.message);
    return { content: "Не получилось передать менеджеру. Попроси посетителя написать в WhatsApp или повторить позже.", is_error: true };
  }
}
