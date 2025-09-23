const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');

// Check if token exists
if (!process.env.TGTOKEN) {
  console.error('❌ TGTOKEN environment variable not set!');
  process.exit(1);
}

// Check if admin ID exists
if (!process.env.ADMIN_ID) {
  console.error('❌ ADMIN_ID environment variable not set!');
  process.exit(1);
}

console.log('✅ Bot token found');
console.log('🔍 Token format check:', process.env.TGTOKEN.match(/^\d+:[A-Za-z0-9_-]+$/) ? 'VALID' : 'INVALID');
console.log('📏 Token length:', process.env.TGTOKEN.length);
console.log('👮 Admin ID:', process.env.ADMIN_ID);

const bot = new Telegraf(process.env.TGTOKEN);

// Storage for users who have passed the NDA challenge per chat
const passedUsers = new Map(); // chatId -> Set of userIds
const ndaMessages = new Map(); // "chatId_userId" -> messageId

// NDA configuration
let NDA_FILE_ID = null; // Will be set via /upload_nda command
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const NDA_BUTTON_TEXT = '✅ I Agree to the NDA';
const NDA_TIMEOUT_SECONDS = 60;
const BAN_DURATION_MINUTES = 10;

// Flag to track if admin is uploading NDA
let waitingForNDA = false;

// Commands
bot.command('start', (ctx) => {
  console.log(`👋 Start command from user: ${ctx.from.username || ctx.from.first_name} (${ctx.from.id})`);
  return ctx.reply('Hello! I\'m the NDA bot. Send /test to verify I\'m working.');
});

bot.command('test', (ctx) => {
  console.log(`🧪 Test command from user: ${ctx.from.username || ctx.from.first_name} (${ctx.from.id})`);
  return ctx.reply('Bot is working! ✅');
});

bot.command('healthz', (ctx) => {
  console.log(`🏥 Healthz request from user: ${ctx.from.username || ctx.from.first_name} in chat: ${ctx.chat.title || 'private'}`);
  return ctx.reply('I\'m OK! 🤖');
});

// Admin command to initiate NDA upload
bot.command('upload_nda', async (ctx) => {
  // Check if admin
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('❌ Only the admin can use this command');
  }
  
  waitingForNDA = true;
  return ctx.reply('📎 Please send the NDA PDF file now...');
});

// Handle document uploads from admin
bot.on('document', async (ctx) => {
  // Check if it's from admin and we're waiting for NDA
  if (ctx.from.id === ADMIN_ID && waitingForNDA) {
    waitingForNDA = false;
    
    // Save the file ID
    NDA_FILE_ID = ctx.message.document.file_id;
    
    console.log(`[ADMIN] NDA file updated: ${ctx.message.document.file_name} (${NDA_FILE_ID})`);
    
    return ctx.reply(
      `✅ NDA file set successfully!\n` +
      `📄 File: ${ctx.message.document.file_name || 'document'}\n` +
      `📦 Size: ${(ctx.message.document.file_size / 1024).toFixed(2)} KB\n` +
      `This file will be used for all new members.`
    );
  }
});

// Handle member changes using chat_member (more reliable than new_chat_members)
bot.on('chat_member', async (ctx) => {
  console.log('👤 CHAT MEMBER UPDATE:', JSON.stringify(ctx.update.chat_member, null, 2));
  
  const update = ctx.update.chat_member;
  const oldStatus = update.old_chat_member.status;
  const newStatus = update.new_chat_member.status;
  const user = update.new_chat_member.user;
  
  // Detect when someone joins (was not member, now is member)
  if ((oldStatus === 'left' || oldStatus === 'kicked') && newStatus === 'member') {
    console.log('🎉 NEW MEMBER DETECTED via chat_member!');
    await handleNewMember(ctx, user);
  }
});

// Handle member changes using my_chat_member (backup)
bot.on('my_chat_member', async (ctx) => {
  console.log('👤 MY CHAT MEMBER UPDATE:', JSON.stringify(ctx.update.my_chat_member, null, 2));
  // This is just for the bot itself, not other users
});

// Extract the member handling logic
async function handleNewMember(ctx, member) {
  console.log(`[EVENT] User ${member.username || member.first_name} (${member.id}) joined chat ${ctx.chat.title} (${ctx.chat.id})`);
  
  // Check if NDA file is configured
  if (!NDA_FILE_ID) {
    console.error('[ERROR] No NDA file configured');
    await ctx.reply('⚠️ Bot not configured. Admin needs to run /upload_nda with the NDA file.');
    return;
  }
  
  const chatId = ctx.chat.id;

  if (!passedUsers.has(chatId)) {
    passedUsers.set(chatId, new Set());
  }
  
  if (member.is_bot) return;
  
  try {
    await ctx.restrictChatMember(member.id, {
      can_send_messages: false,
      can_send_media_messages: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false
    });
    
    console.log(`[ACTION] Restricted ${member.username || member.first_name} in chat ${ctx.chat.title}`);
    
    const displayName = member.username ? `@${member.username}` : member.first_name;
    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback(NDA_BUTTON_TEXT, `nda_agree_${chatId}_${member.id}`)
    ]);
    
    // const ndaMessage = await ctx.replyWithDocument(NDA_FILE_ID, {
    //   caption: `📄 ${displayName}, please review the NDA and click below to agree.`,
    //   reply_markup: keyboard.reply_markup
    // });

    const ndaMessage = await ctx.replyWithMarkdown(
      `📄 ${displayName}, please review the [NDA](https://metamask.io/alphafox) and click below to agree.`,
      keyboard
    );
    
    console.log(`[ACTION] NDA sent to ${member.username || member.first_name} in chat ${ctx.chat.title}`);
    
    const messageKey = `${chatId}_${member.id}`;
    ndaMessages.set(messageKey, ndaMessage.message_id);
    
    setTimeout(async () => {
      const chatPassedUsers = passedUsers.get(chatId);
      if (!chatPassedUsers || !chatPassedUsers.has(member.id)) {
        try {
          const banUntil = BAN_DURATION_MINUTES > 0 
            ? Math.floor(Date.now() / 1000) + (BAN_DURATION_MINUTES * 60)
            : 0;
          
          await ctx.banChatMember(member.id, banUntil);
          console.log(`[ACTION] User ${member.username || member.first_name} banned after timeout`);
          
          const messageId = ndaMessages.get(messageKey);
          if (messageId) {
            try {
              await ctx.deleteMessage(messageId);
              console.log(`[ACTION] NDA message deleted after timeout`);
            } catch (err) {
              console.error(`[ERROR] Failed to delete message: ${err.message}`);
            }
            ndaMessages.delete(messageKey);
          }
        } catch (error) {
          console.error(`[ERROR] Failed to ban user: ${error.message}`);
        }
      }
      
      if (chatPassedUsers) {
        chatPassedUsers.delete(member.id);
      }
    }, NDA_TIMEOUT_SECONDS * 1000);
    
  } catch (error) {
    console.error(`[ERROR] Failed to handle new member: ${error.message}`);
  }
}

// Handle NDA agreement button clicks
bot.action(/^nda_agree_(-?\d+)_(\d+)$/, async (ctx) => {
  const chatId = parseInt(ctx.match[1]);
  const userId = parseInt(ctx.match[2]);
  const clickerId = ctx.from.id;
  
  if (userId !== clickerId) {
    return ctx.answerCbQuery('This button is not for you!', { show_alert: true });
  }
  
  if (chatId !== ctx.chat.id) {
    return ctx.answerCbQuery('This button is not valid for this chat!', { show_alert: true });
  }
  
  console.log(`[EVENT] User ${ctx.from.username || ctx.from.first_name} agreed to NDA`);
  
  try {
    if (!passedUsers.has(chatId)) {
      passedUsers.set(chatId, new Set());
    }
    
    passedUsers.get(chatId).add(userId);
    
    await ctx.restrictChatMember(userId, {
      can_send_messages: true,
      can_send_media_messages: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false
    });
    
    console.log(`[ACTION] ${ctx.from.username || ctx.from.first_name} promoted`);
    
    const messageKey = `${chatId}_${userId}`;
    const messageId = ndaMessages.get(messageKey);
    if (messageId) {
      try {
        await ctx.deleteMessage(messageId);
        console.log(`[ACTION] NDA message deleted`);
      } catch (err) {
        console.error(`[ERROR] Failed to delete message: ${err.message}`);
      }
      ndaMessages.delete(messageKey);
    }
    
    await ctx.answerCbQuery('NDA Accepted! Welcome to the chat!');
    
  } catch (error) {
    console.error(`[ERROR] Failed to promote user: ${error.message}`);
    await ctx.answerCbQuery('An error occurred. Please contact an administrator.');
  }
});

// Log ALL updates for debugging
bot.use(async (ctx, next) => {
  console.log('🔥 RECEIVED UPDATE:', JSON.stringify({
    updateType: ctx.updateType,
    chatId: ctx.chat?.id,
    chatTitle: ctx.chat?.title,
    chatType: ctx.chat?.type,
    userId: ctx.from?.id,
    username: ctx.from?.username,
    firstName: ctx.from?.first_name
  }, null, 2));
  
  return next();
});

// Handle ALL messages for debugging
bot.on('message', async (ctx) => {
  console.log('📨 MESSAGE EVENT:', JSON.stringify({
    messageId: ctx.message.message_id,
    text: ctx.message.text?.substring(0, 50),
    hasNewMembers: !!ctx.message.new_chat_members,
    newMembersCount: ctx.message.new_chat_members?.length || 0
  }, null, 2));
});

// Error handling
bot.catch((err, ctx) => {
  console.error('💥 [ERROR]:', err);
});

// Start the bot
console.log('🚀 Starting bot...');

bot.launch({
  allowedUpdates: [
    "message",
    "callback_query", 
    "chat_member",
    "my_chat_member"
  ]
}).then(async () => {
  try {
    const botInfo = await bot.telegram.getMe();
    console.log(`✅ Bot started: ${botInfo.first_name} (@${botInfo.username})`);
    console.log('⏰ Waiting for updates...');
    console.log('⚠️  Remember to run /upload_nda then send your NDA file to configure the bot!');
  } catch (error) {
    console.error('❌ Failed to get bot info:', error);
  }
}).catch((error) => {
  console.error('💥 Failed to start bot:', error);
  process.exit(1);
});

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('🛑 Shutting down...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('🛑 Shutting down...');
  bot.stop('SIGTERM');
});
