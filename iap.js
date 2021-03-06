import { NativeModules, Alert, Platform } from 'react-native';
import iapRecord from './iapRecord';

const isIOS = Platform.OS === 'ios';

// 转化成promise方法
const promisify = (fn, receiver) => (
  (...args) => (
    new Promise((resolve, reject) => {
      fn.apply(receiver, [...args, (err, res) => (
        err ? reject(err) : resolve(res)
      )]);
    })
  )
);

const { InAppUtils, ZKFileUtils } = NativeModules;
const purchaseProduct = isIOS && promisify(InAppUtils.purchaseProduct, { thisArg: InAppUtils });
export const loadProducts = isIOS && promisify(InAppUtils.loadProducts, { thisArg: InAppUtils });


function icloudAvailable() {
  return new Promise((resolve, reject) => {
    ZKFileUtils.isIcloudAvailable((error, available) => {
      if (error) {
        reject(error);
      } else {
        resolve(available);
      }
    });
  });
}

/**
  * ctx:
  * {
  *   productId: number,
  *   isLoggedIn: bool,
  *   login: func,
  *   iapRecordVendor?:
  *     {
  *       getPayRecord,
  *       savePayRecord,
  *       removePayRecord
  *     }
  *   }
  * }
 */
export default class Iap {
  constructor(ctx) {
    this.ctx = ctx || {};
    if (!this.ctx.iapRecordVendor) {
      this.ctx.iapRecordVendor = iapRecord;
    }
  }

  async prepare() {
    await this.getProduct();
  }

  async getProduct() {
    if (this.getProductPromise) {
      const p = await this.getProductPromise;
      return p;
    }
    this.getProductPromise = loadProducts([this.ctx.productId])
      .then((products) => {
        return products && products[0];
      })
      .catch((e) => {
        console.error('failed to loadProduct, id: ', this.ctx, e);
        return Promise.reject(e);
      });

    const ret = await this.getProduct();
    return ret;
  }

  // callback([appStoreProduct, paymentInfo, isCached]),
  // return Promise<[bool, passdata]>, indicate success fail
  // return: [success: bool, passdata]
  async purchase(callback) {
    const { iapRecordVendor, productId, isLoggedIn } = this.ctx;
    const { savePayRecord, removePayRecord, getPayRecord } = iapRecordVendor;
    // 先检查已保存的记录
    let rec = null;
    try {
      rec = await getPayRecord.call(iapRecordVendor, productId);
    } catch (e) {
      console.error('getPayRecord failed, should not happen: ', e);
    }

    if (rec) {
      if (rec.length !== 2) {
        throw new Error('invalid pay record');
      }

      if (!isLoggedIn) {
        return { code: 'RC_IAP_DID_SAVE_REC' };
      }

      let ret = null;
      try {
        ret = await callback({ product: rec[0], payment: rec[1], isRestored: true });
      } catch (e) {
        console.error(e);
        return { code: 'RC_IAP_CALLBACK', error: e };
      }

      if (ret.code !== 'RC_OK') {
        return { code: 'RC_IAP_CALLBACK' };
      }

      try {
        await removePayRecord.call(iapRecordVendor, productId);
      } catch (e) {
        // fixme: any better way to handle this
        console.error('removePayRecord failed, should not happen: ', e);
      }
      return ret;
    }

    let appStoreProduct = null;
    try {
      appStoreProduct = await this.getProduct();
    } catch (e) {
      console.error(e);
      return { code: 'RC_IAP_GET_PRODUCT', error: e };
    }

    if (!appStoreProduct) {
      return { code: 'RC_IAP_GET_PRODUCT' };
    }

    let payment = null;
    try {
      payment = await this.iapPay();
    } catch (e) {
      console.error(e);
      return { code: 'RC_IAP_PURCHASE', error: e };
    }

    if (!payment) {
      return { code: 'RC_IAP_PURCHASE' };
    }

    let callbackRes = null;
    let errorRc = '';
    try {
      if (isLoggedIn) {
        callbackRes = await callback({ product: appStoreProduct, payment });
      }
    } catch (e) {
      console.error(e);
      if (e && e.code) {
        errorRc = e.code;
      }
    }

    const { code, ...rest } = callbackRes || {};
    if (isLoggedIn && code === 'RC_OK') {
      return callbackRes;
    }

    // 提交失败了，或未登录
    try {
      await savePayRecord.call(iapRecordVendor, appStoreProduct, payment);
      return {
        ...rest,
        code: isLoggedIn ? (code || errorRc || 'RC_IAP_CALLBACK') : 'RC_IAP_DID_SAVE_REC',
      };
    } catch (e) {
      console.error(e);
      return { code: 'RC_IAP_SAVE_REC', error: e };
    }
  }

  async iapPay(alertIfNoUser = true) {
    const { isLoggedIn } = this.ctx;
    if (!isLoggedIn && alertIfNoUser) {
      const iapPayResult = await new Promise((resolve, reject) => {
        Alert.alert(
          '友情提示',
          '您正在未登录的情况下购买课程。支付完成后，您可以在本机登录智课账号以便提交订单。如果您需要在其他手机提交订单，请确保已经使用您的Apple Id登录iCloud。',
          [
            {
              text: '先去登录',
              onPress: () => {
                reject('支付已取消');
                this.goLogin();
              },
            },
            {
              text: '继续',
              onPress: () => {
                icloudAvailable()
                  .catch((e) => {
                    console.error('icloudAvailable error: ', e);
                    return false;
                  })
                  .then((avail) => {
                    if (avail) {
                      resolve(this.iapPay(false));
                    } else {
                      reject('请打开iCloud存储权限或登录名师课账号。然后重新尝试购买。');
                    }
                  })
                  .catch((error) => {
                    reject(error);
                  });
              },
            },
            {
              text: '取消',
              onPress: () => {
                reject('支付已取消');
              },
            },
          ]
        );
      });

      return iapPayResult;
    }

    const res = await purchaseProduct(this.ctx.productId);
    return res;
  }

  goLogin() {
    const { login } = this.ctx;
    if (login) {
      login(this.ctx);
    }
  }
}
