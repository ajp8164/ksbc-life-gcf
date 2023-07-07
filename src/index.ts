import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

import {
  BatchResponse,
  TokenMessage,
} from 'firebase-admin/lib/messaging/messaging-api';

admin.initializeApp(functions.config().firebase);
const db = admin.firestore();

exports.sendChatMessagePushNotification = functions.firestore
  .document('ChatMessages/{groupId}/Messages/{messageId}')
  .onCreate(async (snapshot, context) => {
    // Return a promise to ensure this function stays alive while async
    // processing completes otherwise FB might terminate the function before
    // it finishes.
    // See https://firebase.google.com/docs/functions/terminate-functions
    return new Promise<void>((resolve, _reject) => {
      (async () => {
        const chatMessage = snapshot.data();
        const authorId = chatMessage.author.id;

        const groupId = context.params.groupId;
        const groupRef = db.doc(`Groups/${groupId}`);
        const group = (await groupRef.get()).data();

        const messages: TokenMessage[] = [];
        const recipients: string[] = [];

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
                  const badgeCount = user.notifications?.badgeCount + 1 || 1;

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

                    // Keep a parallel array for error handling after send.
                    recipients.push(memberId);
                  });

                  // If the message has not already been read by the recipient then update the
                  // recipients badge count. This can happen when the recipient has the chat thread
                  // open in the app causing messages to be processed nearly immediatley when the
                  // message is received by firestore.
                  const currentStateChatMessage = (
                    await admin
                      .firestore()
                      .doc(
                        `ChatMessages/${group?.id}/Messages/${chatMessage.id}`,
                      )
                      .get()
                  ).data();

                  if (!currentStateChatMessage?.readBy?.[user.id]) {
                    const updatedUser = Object.assign({}, user); // Don't mutate input.
                    updatedUser.notifications = {
                      ...user.notifications,
                      badgeCount,
                    };

                    userRef.update(updatedUser);
                  }
                }
                resolve();
              })();
            }),
          );
        });

        await Promise.all(recipientPromises);

        if (messages.length > 0) {
          admin
            .messaging()
            .sendEach(messages)
            .then(async response => {
              console.log(
                `Chat Push Notifications: ${response.successCount} sent, ${response.failureCount} failed`,
              );
              await cleanupBadTokens(response, messages, recipients);

              // Finished. Allow firebase to terminate this function.
              resolve();
            });
        }
      })();
    });
  });

// Remove push tokens that caused a send failure.
//
const cleanupBadTokens = async (
  response: BatchResponse,
  messages: TokenMessage[],
  recipients: string[],
) => {
  for (let i = 0; i < response.responses.length; i++) {
    const r = response.responses[i];
    if (r.error) {
      const uid = recipients[i];
      const token = messages[i].token;

      const user = (await admin.firestore().doc(`Users/${uid}`).get()).data();
      if (user) {
        const index = user.notifications.pushTokens.indexOf(token);
        if (index !== -1) {
          user.notifications.pushTokens.splice(index, 1);
        }
        admin.firestore().doc(`Users/${uid}`).set(user);

        console.error(
          `Token removed: ${r.error.code} - ${r.error.message} / ${messages[i].token} / user ${uid}`,
        );
      } else {
        console.error(
          `${r.error.code} - ${r.error.message} / ${messages[i].token}`,
        );
      }
    }
  }
};
