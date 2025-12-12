/**
 * 数据持久化层 (Core Storage Service)
 * 负责与 LocalStorage 进行交互，提供标准的 CRUD 接口
 */
export class StorageService {
    constructor(storageKey) {
        this.storageKey = storageKey;
        // 初始化：如果还没有数据，写入空数组，防止后续报错
        if (!localStorage.getItem(this.storageKey)) {
            localStorage.setItem(this.storageKey, JSON.stringify([]));
        }
    }

    /**
     * 获取所有记录
     * @returns {Array} 记录数组
     */
    getAll() {
        try {
            const data = localStorage.getItem(this.storageKey);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            console.error(`Error reading ${this.storageKey}:`, e);
            return [];
        }
    }

    /**
     * 保存新记录 (Create)
     * @param {Object} data - 要保存的数据对象
     * @returns {Object} 带有自动生成 ID 的完整记录
     */
    save(data) {
        const records = this.getAll();
        // 自动生成 ID (使用时间戳)
        const newRecord = { 
            ...data, 
            id: Date.now() 
        };
        records.unshift(newRecord); // 新记录插到最前面
        this._persist(records);
        return newRecord;
    }

    /**
     * 更新现有记录 (Update)
     * @param {number|string} id - 记录ID
     * @param {Object} updatedData - 更新后的完整数据对象
     * @returns {boolean} 是否更新成功
     */
    update(id, updatedData) {
        const records = this.getAll();
        const index = records.findIndex(r => r.id == id); // 使用 == 兼容字符串/数字ID
        
        if (index !== -1) {
            // 保持 ID 不变，覆盖其他属性
            records[index] = { ...updatedData, id: records[index].id };
            this._persist(records);
            return true;
        }
        console.warn(`Record with id ${id} not found in ${this.storageKey}`);
        return false;
    }

    /**
     * 删除记录 (Delete)
     * @param {number|string} id - 记录ID
     * @returns {boolean} 是否删除成功
     */
    delete(id) {
        let records = this.getAll();
        const initialLength = records.length;
        records = records.filter(r => r.id != id);
        
        if (records.length !== initialLength) {
            this._persist(records);
            return true;
        }
        return false;
    }

    /**
     * 内部私有方法：写入 LocalStorage
     */
    _persist(data) {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(data));
        } catch (e) {
            console.error(`Error writing to ${this.storageKey}:`, e);
            alert('存储空间已满或写入失败，数据可能未保存！');
        }
    }
}