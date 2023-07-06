import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

import { TokenMessage } from 'firebase-admin/lib/messaging/messaging-api';

admin.initializeApp(functions.config().firebase);
const db = admin.firestore();

exports.sendChatMessagePushNotification = functions.firestore
  .document('ChatMessages/{groupId}/Messages/{messageId}')
  .onCreate(async (snapshot, context) => {
    const chatMessage = snapshot.data();
    const authorId = chatMessage.author.id;

    const groupId = context.params.groupId;
    const groupRef = db.doc(`Groups/${groupId}`);
    const group = (await groupRef.get()).data();

    const messages: TokenMessage[] = [];

    const recipientPromises: Promise<void>[] = [];
    (group?.members as string[]).forEach(memberId => {
      recipientPromises.push(
        new Promise<void>((resolve, _reject) => {
          (async () => {
            const userRef = db.doc(`Users/${memberId}`);
            const user = (await userRef.get()).data();

            // Author doesn't get a push notification on their own message.
            // The recipient must have push tokens.
            if (
              user &&
              user.id !== authorId &&
              user.notifications.pushTokens.length > 0
            ) {
              // Increment the users badge count.
              const badgeCount = user.notifications?.badgeCount + 1 || 0;

              // Create the message.
              const title = `${chatMessage.author.firstName} ${chatMessage.author.lastName}`;
              let body = 'New message';
              let imageUrl: string;

              if (chatMessage?.type === 'text') {
                body = chatMessage.text;
              } else if (chatMessage?.type === 'file') {
                body = 'Attachment: File';
              } else if (chatMessage?.type === 'image') {
                body = 'Attachment: Image';
                imageUrl = chatMessage.uri;
              } else if (chatMessage?.type === 'video') {
                body = 'Attachment: Video';
                imageUrl = chatMessage.posterUri;
              }

              // Send the notification to each registered device.
              user.notifications.pushTokens.forEach((token: string) => {
                messages.push({
                  token,
                  notification: {
                    title,
                    body,
                    imageUrl,
                  },
                  android: {
                    notification: {
                      imageUrl,
                      notificationCount: 1, // This message represents one notification (diff than iOS).
                    },
                  },
                  apns: {
                    payload: {
                      aps: {
                        badge: badgeCount,
                      },
                    },
                    fcmOptions: {
                      imageUrl,
                    },
                  },
                });
              });

              // Increment the notification badge count for the user (applies mainly for iOS only).
              const updatedUser = Object.assign({}, user); // Don't mutate input.
              updatedUser.notifications = {
                ...user.notifications,
                badgeCount: user.notifications?.badgeCount
                  ? user.notifications?.badgeCount + 1
                  : 1,
              };

              userRef.update(updatedUser);
            }
            resolve();
          })();
        }),
      );
    });

    if (recipientPromises.length) {
      await Promise.all(recipientPromises);

      if (messages.length > 0) {
        admin
          .messaging()
          .sendEach(messages)
          .then(response => {
            console.log(
              `Chat Push Notifications: ${response.successCount} sent, ${response.failureCount} failed`,
            );
            for (let i = 0; i < response.responses.length; i++) {
              const r = response.responses[i];
              if (r.error) {
                console.error(
                  `${r.error.code} - ${r.error.message} / ${messages[i].token}`,
                );
              }
            }
          });
      }
    }
  });
