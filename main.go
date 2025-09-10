package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	tb "gopkg.in/tucnak/telebot.v2"
)

var (
	bot         *tb.Bot
	passedUsers = sync.Map{}
	token       = os.Getenv("TGTOKEN") // export TGTOKEN=xxxx before run

	welcomeMsg  = "📜 Before participating, you must agree to this NDA:\n\n[Insert NDA text or link here]\n\nClick below to accept within %d seconds, or you will be removed."
	successMsg  = "✅ %s has agreed to the NDA and can now chat."
	failMsg     = "❌ %s did not agree to the NDA in time and was removed."
	timeoutSecs = 60
)

func main() {
	if token == "" {
		log.Fatal("⚠️ Please set TGTOKEN environment variable with your bot token")
	}

	var err error
	bot, err = tb.NewBot(tb.Settings{
		Token:  token,
		Poller: &tb.LongPoller{Timeout: 10 * time.Second},
	})
	if err != nil {
		log.Fatalf("Cannot start bot: %v", err)
	}

	// New members
	bot.Handle(tb.OnUserJoined, challengeUser)

	// NDA agreement button (catch all "agree_" callbacks)
	bot.Handle(&tb.InlineButton{Unique: "agree"}, passChallenge)

	log.Println("🤖 NDA Bot started!")

	go bot.Start()

	// Graceful shutdown
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Println("Shutdown signal received, exiting...")
}

func challengeUser(m *tb.Message) {
	user := m.UserJoined
	chat := m.Chat
	log.Printf("👤 User %s (%d) joined chat %s (%d)", user.Username, user.ID, chat.Title, chat.ID)

	// Restrict user immediately (mute)
	restricted := tb.ChatMember{
		User:            user,
		Rights:          tb.NoRights(),
		RestrictedUntil: tb.Forever(),
	}
	if err := bot.Restrict(chat, &restricted); err != nil {
		log.Printf("⚠️ Failed to restrict %s: %v", user.Username, err)
	}

	// NDA message with button
	btn := tb.InlineButton{
		Unique: "agree",
		Text:   "✅ I Agree to NDA",
		Data:   strconv.FormatInt(user.ID, 10), // store userID in button data
	}
	inlineKeys := [][]tb.InlineButton{{btn}}

	msg, err := bot.Reply(m, fmt.Sprintf(welcomeMsg, timeoutSecs), &tb.ReplyMarkup{InlineKeyboard: inlineKeys})
	if err != nil {
		log.Printf("⚠️ Failed to send NDA message: %v", err)
		return
	}

	// Kick after timeout if no agreement
	time.AfterFunc(time.Duration(timeoutSecs)*time.Second, func() {
		if _, ok := passedUsers.Load(user.ID); !ok {
			if err := bot.Ban(chat, &tb.ChatMember{User: user}); err != nil {
				log.Printf("⚠️ Failed to kick %s: %v", user.Username, err)
			}
			bot.Edit(msg, fmt.Sprintf(failMsg, user.FirstName))
			log.Printf("⛔ %s (%d) kicked from chat %s", user.Username, user.ID, chat.Title)
		}
		passedUsers.Delete(user.ID)
	})
}

func passChallenge(c *tb.Callback) {
	user := c.Sender
	chat := c.Message.Chat

	expectedID := c.Data
	if expectedID != strconv.FormatInt(user.ID, 10) {
		// Someone else clicked
		bot.Respond(c, &tb.CallbackResponse{Text: "⚠️ This button isn’t for you!"})
		return
	}

	passedUsers.Store(user.ID, struct{}{})

	// Unrestrict user
	member := tb.ChatMember{
		User:            user,
		Rights:          tb.Rights{CanSendMessages: true, CanSendMedia: true, CanSendPolls: true},
		RestrictedUntil: tb.Forever(),
	}
	if err := bot.Promote(chat, &member); err != nil {
		log.Printf("⚠️ Failed to unrestrict %s: %v", user.Username, err)
	}

	// Update message
	bot.Edit(c.Message, fmt.Sprintf(successMsg, user.FirstName))
	bot.Respond(c, &tb.CallbackResponse{Text: "✅ NDA accepted, welcome!"})

	log.Printf("✅ User %s (%d) accepted NDA in chat %s", user.Username, user.ID, chat.Title)
}
