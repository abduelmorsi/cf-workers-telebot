import TelegramBot from 'telegram-webhook-js';

function convertToHtmlFormat(text) {
    return text
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')  // **bold**
        .replace(/\*(.*?)\*/g, '<i>$1</i>')      // *italic*
        .replace(/__(.*?)__/g, '<u>$1</u>')      // __underline__
        .replace(/~~(.*?)~~/g, '<s>$1</s>')      // ~~strikethrough~~
        .replace(/`(.*?)`/g, '<code>$1</code>')  // `code`
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>'); // [text](url)
}

export default {
    async fetch(request, env, ctx) {
        const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN);
        const url = new URL(request.url);

        // Handle API endpoints
        if (url.pathname.startsWith('/api/')) {
            return handleApiRequest(request, env);
        }

        // Handle webhook
        if (url.pathname === '/webhook') {
            const updates = await request.json();
            await handleUpdate(updates, bot, env.USER_DATA, env);
            return new Response('OK', { status: 200 });
        }

        // Serve static files
        return env.ASSETS.fetch(request);
    }
};

async function handleApiRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Authentication endpoint
    if (path === '/api/auth' && request.method === 'POST') {
        const { chatId } = await request.json();
        const isValidAdmin = isAdmin(Number(chatId), env);
        return new Response(JSON.stringify({ success: isValidAdmin }), {
            status: isValidAdmin ? 200 : 403,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Button management endpoints
    if (path === '/api/buttons') {
        if (request.method === 'GET') {
            const buttons = await env.USER_DATA.get('buttons', { type: 'json' }) || [];
            return new Response(JSON.stringify(buttons), {
                headers: { 'Content-Type': 'application/json' }
            });
        }
        
        if (request.method === 'POST') {
            const { text, response, parentId } = await request.json();
            const buttons = await env.USER_DATA.get('buttons', { type: 'json' }) || [];
            const newButton = { 
                id: Date.now().toString(), 
                text, 
                response: convertToHtmlFormat(response), 
                subButtons: [] 
            };

            if (parentId) {
                // Add as sub-button to parent
                function addSubButton(buttonsArray) {
                    for (let button of buttonsArray) {
                        if (button.id === parentId) {
                            if (!button.subButtons) button.subButtons = [];
                            button.subButtons.push(newButton);
                            return true;
                        }
                        if (button.subButtons && addSubButton(button.subButtons)) {
                            return true;
                        }
                    }
                    return false;
                }
                addSubButton(buttons);
            } else {
                // Add as top-level button
                buttons.push(newButton);
            }

            await env.USER_DATA.put('buttons', JSON.stringify(buttons));
            await refreshAllKeyboards(env.USER_DATA, new TelegramBot(env.TELEGRAM_BOT_TOKEN));
            return new Response(JSON.stringify(newButton));
        }
    }

    if (path.startsWith('/api/buttons/') && (request.method === 'DELETE' || request.method === 'PUT' || request.method === 'GET')) {
        const buttonId = path.split('/').pop();
        const buttons = await env.USER_DATA.get('buttons', { type: 'json' }) || [];
        
        if (request.method === 'DELETE') {
            const newButtons = buttons.filter(b => b.id !== buttonId);
            await env.USER_DATA.put('buttons', JSON.stringify(newButtons));
            // Refresh keyboards after deletion
            await refreshAllKeyboards(env.USER_DATA, new TelegramBot(env.TELEGRAM_BOT_TOKEN));
            return new Response(JSON.stringify({ success: true }));
        }
        
        if (request.method === 'PUT') {
            const { text, response } = await request.json();
            const newButtons = buttons.map(b => 
                b.id === buttonId ? { ...b, text, response: convertToHtmlFormat(response) } : b
            );
            await env.USER_DATA.put('buttons', JSON.stringify(newButtons));
            // Refresh keyboards after update
            await refreshAllKeyboards(env.USER_DATA, new TelegramBot(env.TELEGRAM_BOT_TOKEN));
            return new Response(JSON.stringify({ success: true }));
        }

        if (request.method === 'GET') {
            const button = buttons.find(b => b.id === buttonId);
            if (!button) return new Response('Not Found', { status: 404 });
            return new Response(JSON.stringify(button), {
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    return new Response('Not Found', { status: 404 });
}

async function handleUpdate(update, bot, KV_NAMESPACE, env) {
    console.log('Update received:', JSON.stringify(update));

    if (update.callback_query) {
        const callbackData = update.callback_query.data;
        const chatId = update.callback_query.message.chat.id;
        const buttons = await KV_NAMESPACE.get('buttons', { type: 'json' }) || [];
        const matchedButton = findButtonById(buttons, callbackData);
        
        if (matchedButton) {
            if (matchedButton.subButtons?.length > 0) {
                // If button has sub-buttons, show them as a new keyboard
                const keyboardRows = chunks(matchedButton.subButtons.map(btn => ({
                    text: btn.text
                })), 2);

                await bot.sendMessage(chatId, `${matchedButton.text} options:`, {
                    replyMarkup: {
                        keyboard: keyboardRows,
                        resize_keyboard: true,
                        one_time_keyboard: false
                    }
                });
            }
            // Send the button's response
            await bot.sendMessage(chatId, matchedButton.response, {
                parseMode: 'HTML'
            });
            await bot.answerCallbackQuery(update.callback_query.id, 'Success!');
            return;
        }
    }

    const message = update.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();
    
    // Handle back button
    if (text === '⬅️ Back') {
        await showMainMenu(chatId, bot, KV_NAMESPACE, true);
        return;
    }

    // Handle custom buttons
    const buttons = await KV_NAMESPACE.get('buttons', { type: 'json' }) || [];
    const matchedButton = findButtonByText(buttons, text.replace(' 📁', ''));
    if (matchedButton) {
        if (matchedButton.subButtons?.length > 0) {
            // If clicked button has sub-buttons, show them as keyboard
            const keyboardRows = chunks(matchedButton.subButtons.map(btn => ({
                text: btn.text
            })), 2);

            // Add back button at the top of sub-menu
            keyboardRows.unshift([{ text: '⬅️ Back' }]);

            await bot.sendMessage(chatId, `${matchedButton.text}:`, {
                replyMarkup: {
                keyboard: keyboardRows,
                resize_keyboard: true,
                one_time_keyboard: false
                }
            });
        }
        
        await bot.sendMessage(chatId, matchedButton.response, {
            parseMode: 'HTML'
        });
        return;
    }

    if (text.toLowerCase() === '/start' || text.toLowerCase() === '/refresh' || text.toLowerCase() === '/menu') {
        await showMainMenu(chatId, bot, KV_NAMESPACE);
        if (text.toLowerCase() === '/start') {
            await KV_NAMESPACE.put(`user_${chatId}_started`, 'true');
        }
        return;
    } 
	else if (text.startsWith('/save')) {
        const userData = text.slice(6).trim();
        await KV_NAMESPACE.put(`user_${chatId}`, userData);
        await bot.sendMessage(chatId, 'Data saved.');
    } 
	else if (text.startsWith('/get')) {
        const data = await KV_NAMESPACE.get(`user_${chatId}`);
        await bot.sendMessage(chatId, 'Saved Data: '+data);
    }
	else if (text.startsWith('/update')) {
        const userData = text.slice(8).trim();
        await KV_NAMESPACE.put(`user_${chatId}`, userData);
        await bot.sendMessage(chatId, 'Data updated.');
    } 
	else if (text.startsWith('/delete')) {
        await KV_NAMESPACE.delete(`user_${chatId}`);
        await bot.sendMessage(chatId, 'Data deleted.');
    } 
	else if (text.startsWith('/broadcast ') && isAdmin(chatId, env)) {
        const message = text.slice(10).trim();
        await broadcastMessage(bot, KV_NAMESPACE, message);
        await bot.sendMessage(chatId, 'Broadcast sent!');
    } 
	else {
        await bot.sendMessage(chatId, `Unknown command: ${text}`);
    }
}

// Helper function to chunk array into smaller arrays
function chunks(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

function isAdmin(chatId, env) {
    const adminIds = env.ADMIN_IDS.split(',').map(id => Number(id));
    return adminIds.includes(chatId);
}

async function broadcastMessage(bot, KV_NAMESPACE, message) {
    const { keys } = await KV_NAMESPACE.list({ prefix: 'user_' });
    for (const key of keys) {
        if (key.name.endsWith('_started')) {
            const chatId = key.name.split('_')[1];
            try {
                await bot.sendMessage(chatId, message);
            } catch (error) {
                console.error(`Failed to send message to ${chatId}:`, error);
            }
        }
    }
}

// Update refreshAllKeyboards to only show top-level buttons
async function refreshAllKeyboards(KV_NAMESPACE, bot) {
    const { keys } = await KV_NAMESPACE.list({ prefix: 'user_' });
    for (const key of keys) {
        if (key.name.endsWith('_started')) {
            const chatId = key.name.split('_')[1];
            try {
                await showMainMenu(chatId, bot, KV_NAMESPACE);
            } catch (error) {
                console.error(`Failed to update keyboard for ${chatId}:`, error);
            }
        }
    }
}

// Add this helper function to recursively find buttons by ID
function findButtonById(buttons, id) {
    for (const button of buttons) {
        if (button.id === id) return button;
        if (button.subButtons) {
            const found = findButtonById(button.subButtons, id);
            if (found) return found;
        }
    }
    return null;
}

// Add new helper functions
async function showMainMenu(chatId, bot, KV_NAMESPACE, showMessage = false) {
    const buttons = await KV_NAMESPACE.get('buttons', { type: 'json' }) || [];
    if (!buttons || buttons.length === 0) return;

    const topLevelButtons = buttons.filter(b => !b.parentId);
    const keyboardRows = chunks(topLevelButtons.map(btn => ({
        text: btn.text
    })), 2);

    await bot.sendMessage(chatId, showMessage ? 'Menu' : '', {
        replyMarkup: {
            keyboard: keyboardRows,
            resize_keyboard: true,
            one_time_keyboard: false
        }
    });
}

function findButtonByText(buttons, searchText) {
    for (const button of buttons) {
        if (button.text.toLowerCase() === searchText.toLowerCase()) return button;
        if (button.subButtons) {
            const found = findButtonByText(button.subButtons, searchText);
            if (found) return found;
        }
    }
    return null;
}