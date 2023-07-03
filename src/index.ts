import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

import { MulticastMessage } from 'firebase-admin/lib/messaging/messaging-api';

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

    const tokens: string[] = [];

    const memberTokenPromises: Promise<void>[] = [];
    (group?.members as string[]).forEach(memberId => {
      memberTokenPromises.push(
        new Promise<void>((resolve, _reject) => {
          (async () => {
            const userRef = db.doc(`Users/${memberId}`);
            const user = (await userRef.get()).data();
            // Author doesn't get a push notification on their own message.
            if (user && user.id !== authorId) {
              user.pushTokens.forEach((t: string) => {
                tokens.push(t);
              });
            }
            resolve();
          })();
        }),
      );
    });

    if (memberTokenPromises.length) {
      await Promise.all(memberTokenPromises);
    }

    const title = `${chatMessage.author.firstName} ${chatMessage.author.lastName}`;
    let body = 'New message';
    let imageUrl;

    if (chatMessage?.type === 'text') {
      body = chatMessage.text;
    } else if (chatMessage?.type === 'file') {
      body = 'Attachment: File';
    } else if (chatMessage?.type === 'image') {
      body = 'Attachment: Image';
      imageUrl = chatMessage.uri;
    }

    const message: MulticastMessage = {
      notification: {
        title,
        body,
        imageUrl,
      },
      tokens,
    };

    console.log('message', message);

    return admin.messaging().sendEachForMulticast(message);
  });
