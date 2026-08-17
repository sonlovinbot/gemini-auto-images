# Nội dung Chrome Web Store

## Mô tả ngắn

🎨 Tạo và tải ảnh hàng loạt bằng phiên Gemini đang đăng nhập, với hàng đợi bền vững và khả năng khôi phục tác vụ.

## Mô tả chi tiết


## Danh mục và ngôn ngữ

- Category: Art & Design
- Language: Vietnamese

## Giải trình quyền

### Single purpose description

Help users run image-generation prompts and optional reference images sequentially in their signed-in Gemini tab, then save each completed image locally.

- `alarms`: đánh thức tiến trình nền để tiếp tục kiểm tra và khôi phục tác vụ dài.
- `downloads`: lưu ảnh kết quả vào thiết bị và tôn trọng thư mục tải xuống do người dùng cấu hình.
- `scripting`: chạy bộ thực thi đóng gói cùng tiện ích trong trang Gemini để thao tác giao diện và đọc bytes ảnh đã tạo.
- `sidePanel`: cung cấp giao diện tạo, hàng đợi, nhật ký và cài đặt trong bảng bên của Chrome.
- `storage`: lưu hàng đợi, cài đặt, nhật ký và trạng thái khôi phục cục bộ.
- `tabs`: tìm hoặc mở tab Gemini, theo dõi URL cuộc trò chuyện và khôi phục tác vụ trong đúng tab.
- `https://gemini.google.com/*`: gửi prompt/ảnh tham chiếu do người dùng yêu cầu và nhận ảnh kết quả trong phiên Gemini đã đăng nhập.
- `http://localhost/*`, `http://127.0.0.1/*`: kết nối tùy chọn với ứng dụng VOX chạy cục bộ để nhận tác vụ và trả ảnh kết quả.

## Dữ liệu và mã từ xa

- Dữ liệu trang web: prompt, ảnh tham chiếu và ảnh được tạo; chỉ dùng để cung cấp tính năng người dùng kích hoạt.
- Không bán dữ liệu, không dùng cho quảng cáo, chấm điểm tín dụng hoặc mục đích không liên quan.
- Remote code: No. Mọi mã thực thi đều nằm trong gói tiện ích.

## Hướng dẫn kiểm thử cho reviewer

1. Đăng nhập Gemini bằng tài khoản thử nghiệm có quyền tạo ảnh.
2. Mở `https://gemini.google.com/app`.
3. Mở Auto Gemini Images bằng biểu tượng tiện ích để hiện side panel.
4. Trong tab Tạo ảnh, nhập một prompt đơn giản rồi bấm Thêm và chạy.
5. Trong Hàng chờ, xác nhận tác vụ chạy, ảnh kết quả xuất hiện và có thể tải xuống.

Tích hợp VOX trên localhost là tùy chọn và không cần để kiểm thử luồng chính.
