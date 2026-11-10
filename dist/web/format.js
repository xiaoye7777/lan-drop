// 显示用的格式化函数
export function formatSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}
function pad(value) {
    return String(value).padStart(2, '0');
}
export function formatTime(at) {
    const date = new Date(at);
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** 距今天相差几个自然日：今天 0，昨天 -1，明天 1 */
function dayOffset(at) {
    const startOfDay = (time) => new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime();
    return Math.round((startOfDay(new Date(at)) - startOfDay(new Date())) / (24 * 60 * 60 * 1000));
}
export function formatDay(at) {
    const offset = dayOffset(at);
    if (offset === 0)
        return '今天';
    if (offset === -1)
        return '昨天';
    const date = new Date(at);
    // 聊天记录永久保存，不是今年的要带上年份
    const year = date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()} 年 `;
    return `${year}${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}
export function dayKey(at) {
    const date = new Date(at);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
/** 文件卡片上显示的扩展名，没有扩展名时显示“文件” */
export function fileExtension(name) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1)
        return '文件';
    return name.slice(dot + 1, dot + 5).toUpperCase();
}
/** 日期加时间，用在搜索结果和转发的聊天记录里：今天只显示时间，其他显示日期 */
export function formatDateTime(at) {
    return dayOffset(at) === 0 ? formatTime(at) : `${formatDay(at)} ${formatTime(at)}`;
}
